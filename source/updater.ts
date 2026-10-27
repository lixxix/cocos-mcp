// @ts-ignore
import packageJSON from '../package.json';
import {
    createWriteStream,
    emptyDir,
    ensureDir,
    existsSync,
    move,
    copy,
    readFileSync,
    remove,
    statSync,
    writeFileSync,
} from 'fs-extra';
import { spawn } from 'child_process';
import { get as httpsGet } from 'https';
import { join, basename } from 'path';
import { log, getLogDir } from './logger';
import { stopMcpServer } from './mcp-process';

/**
 * 扩展自更新。
 *
 * 更新源是 GitHub 仓库的某个分支，配置在扩展 package.json 的 update 字段：
 *  - 检查：GET raw.githubusercontent.com 上的 package.json，与本地版本号比较，结果缓存 1 小时；
 *  - 更新：下载分支 zip -> 系统 tar / PowerShell 解压 -> 校验版本 -> 覆盖扩展目录。
 *
 * 覆盖前会先停掉 mcp-server 子进程释放文件句柄；旧目录改名留作 .bak，改名失败
 * （Windows 偶发文件占用）则退化为原地覆盖。重载扩展不由这里做——disable 自己
 * 会杀掉正在返回结果的主进程，由面板拿到成功结果后再触发。
 */

interface UpdateConfig {
    /** GitHub 仓库，"owner/repo"，空 = 未配置 */
    repo?: string;
    /** 分支名，默认 main */
    branch?: string;
    /** 仓库内扩展所在子目录，仓库根就是扩展时留空 */
    subdir?: string;
}

export interface UpdateCheckResult {
    ok: boolean;
    current: string;
    latest?: string;
    hasUpdate: boolean;
    checkedAt?: number;
    /** true 表示来自 1 小时内的本地缓存 */
    cached?: boolean;
    error?: string;
}

export interface UpdateApplyResult {
    ok: boolean;
    from?: string;
    to?: string;
    /** 旧目录备份路径（原地覆盖模式下为空） */
    backup?: string;
    notice?: string;
    error?: string;
}

/** 扩展根目录：<扩展>/dist/updater.js 的上级 */
export function extensionDir(): string {
    return join(__dirname, '..');
}

function updateConfig(): UpdateConfig {
    return ((packageJSON as any).update || {}) as UpdateConfig;
}

function normalizeSubdir(subdir?: string): string {
    return String(subdir || '').replace(/^\/+|\/+$/g, '');
}

/**
 * 比较 a 与 b：>0 表示 a 更新。忽略 -beta 之类后缀，非数字段按 0 处理。
 */
export function compareVersions(a: string, b: string): number {
    const parts = (v: string) =>
        String(v || '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
    const pa = parts(a);
    const pb = parts(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const da = pa[i] || 0;
        const db = pb[i] || 0;
        if (da !== db) return da - db;
    }
    return 0;
}

const USER_AGENT = 'cocos-mcp-updater';

/**
 * GET 一个文本资源，手动跟随重定向（node:https 不自动跟随）。
 */
function fetchText(url: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const request = (target: string, hops: number) => {
            if (hops > 5) {
                reject(new Error(`重定向次数过多：${url}`));
                return;
            }
            const req = httpsGet(
                target,
                { timeout: timeoutMs, headers: { 'User-Agent': USER_AGENT } },
                (res) => {
                    const status = res.statusCode || 0;
                    const location = res.headers.location ? String(res.headers.location) : '';
                    if (status >= 300 && status < 400 && location) {
                        res.resume();
                        request(new URL(location, target).toString(), hops + 1);
                        return;
                    }
                    if (status !== 200) {
                        res.resume();
                        reject(new Error(`HTTP ${status}：${target}${status === 404 ? '（仓库不存在、分支不对，或仓库是私有的）' : ''}`));
                        return;
                    }
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                    res.on('error', reject);
                },
            );
            req.on('timeout', () => req.destroy(new Error(`请求超时：${target}`)));
            req.on('error', reject);
        };
        request(url, 0);
    });
}

/**
 * 下载到文件，同样手动跟随重定向。GitHub 的分支 zip 地址会 302 到 codeload.github.com。
 */
function downloadFile(url: string, destFile: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = (target: string, hops: number) => {
            if (hops > 5) {
                reject(new Error(`下载重定向次数过多：${url}`));
                return;
            }
            const req = httpsGet(
                target,
                { timeout: timeoutMs, headers: { 'User-Agent': USER_AGENT } },
                (res) => {
                    const status = res.statusCode || 0;
                    const location = res.headers.location ? String(res.headers.location) : '';
                    if (status >= 300 && status < 400 && location) {
                        res.resume();
                        request(new URL(location, target).toString(), hops + 1);
                        return;
                    }
                    if (status !== 200) {
                        res.resume();
                        reject(new Error(`下载失败 HTTP ${status}：${target}`));
                        return;
                    }
                    const out = createWriteStream(destFile);
                    out.on('error', reject);
                    out.on('finish', () => resolve());
                    res.on('error', reject);
                    res.pipe(out);
                },
            );
            req.on('timeout', () => req.destroy(new Error(`下载超时：${target}`)));
            req.on('error', reject);
        };
        request(url, 0);
    });
}

const CHECK_CACHE_FILE = 'update-check.json';
const CHECK_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * 检查更新。force=false 时 1 小时内的缓存直接返回（面板打开时的自动检查用）。
 */
export async function checkForUpdate(opts?: { force?: boolean }): Promise<UpdateCheckResult> {
    const current = String((packageJSON as any).version || '0.0.0');
    const cfg = updateConfig();
    const repo = String(cfg.repo || '').trim();
    if (!repo || repo.indexOf('/') < 0) {
        return {
            ok: false,
            current,
            hasUpdate: false,
            error: '更新源未配置：在扩展 package.json 的 update.repo 里填入 GitHub 仓库（owner/repo）',
        };
    }
    const branch = String(cfg.branch || 'main');
    const subdir = normalizeSubdir(cfg.subdir);

    const cacheFile = join(getLogDir(), CHECK_CACHE_FILE);
    if (!opts || !opts.force) {
        try {
            if (existsSync(cacheFile)) {
                const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
                const fresh =
                    cached && cached.repo === repo && cached.branch === branch &&
                    cached.current === current &&
                    Date.now() - (cached.checkedAt || 0) < CHECK_CACHE_TTL_MS;
                if (fresh && cached.result) {
                    return Object.assign({}, cached.result, { cached: true }) as UpdateCheckResult;
                }
            }
        } catch (e) {
            // 缓存读不出来当没有缓存处理
        }
    }

    const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${subdir ? subdir + '/' : ''}package.json`;
    try {
        const remote = JSON.parse(await fetchText(rawUrl, 8000));
        const latest = String(remote.version || '');
        if (!latest) throw new Error('远端 package.json 缺少 version 字段');
        const result: UpdateCheckResult = {
            ok: true,
            current,
            latest,
            hasUpdate: compareVersions(latest, current) > 0,
            checkedAt: Date.now(),
        };
        try {
            writeFileSync(
                cacheFile,
                JSON.stringify({ repo, branch, current, checkedAt: result.checkedAt, result }, null, 2),
                'utf8',
            );
        } catch (e) {
            // 写缓存失败不影响本次结果
        }
        log('update-check', { current, latest, hasUpdate: result.hasUpdate });
        return result;
    } catch (e: any) {
        const message = e && e.message ? e.message : String(e);
        log('update-check', { error: message }, 'warn');
        return { ok: false, current, hasUpdate: false, error: message };
    }
}

function timestampStamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * 解压 zip：Windows 优先用 System32 自带的 bsdtar（PATH 里的 tar 可能是
 * Git Bash 的 GNU tar，不认识 zip），失败再退 PATH tar、PowerShell；
 * 非 Windows 用系统 tar（macOS 的 bsdtar 支持 zip），最后试 unzip。
 */
function extractZip(zipFile: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const attempts: { cmd: string; args: string[] }[] = [];
        if (process.platform === 'win32') {
            const bsdtar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
            if (existsSync(bsdtar)) {
                attempts.push({ cmd: bsdtar, args: ['-xf', zipFile, '-C', destDir] });
            }
            attempts.push({ cmd: 'tar', args: ['-xf', zipFile, '-C', destDir] });
            // -EncodedCommand 传 base64，绕开 PowerShell 的引号/空格坑
            const script = `Expand-Archive -LiteralPath "${zipFile}" -DestinationPath "${destDir}" -Force`;
            const encoded = Buffer.from(script, 'utf16le').toString('base64');
            attempts.push({
                cmd: 'powershell',
                args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            });
        } else {
            attempts.push({ cmd: 'tar', args: ['-xf', zipFile, '-C', destDir] });
            attempts.push({ cmd: 'unzip', args: ['-o', zipFile, '-d', destDir] });
        }

        const lastError: string[] = [];
        const runOne = (i: number) => {
            if (i >= attempts.length) {
                reject(new Error(`zip 解压失败（tar/PowerShell/unzip 均不可用）：${lastError.join('；') || '未知原因'}`));
                return;
            }
            const { cmd, args } = attempts[i];
            let stderr = '';
            const child = spawn(cmd, args, { windowsHide: true });
            let settled = false;
            child.stdout.on('data', () => { /* tar 解压无输出即成功，忽略 */ });
            child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
            child.on('error', (e) => {
                // 通常是命令不存在（ENOENT），换下一个方案
                lastError.push(`${cmd}: ${e.message}`);
                if (!settled) runOne(i + 1);
            });
            child.on('exit', (code) => {
                settled = true;
                if (code === 0) {
                    resolve();
                    return;
                }
                lastError.push(`${cmd}: exit ${code} ${stderr.slice(0, 300)}`);
                runOne(i + 1);
            });
        };
        emptyDir(destDir)
            .then(() => runOne(0))
            .catch(reject);
    });
}

/**
 * 执行更新：下载 zip -> 解压 -> 校验 -> 覆盖扩展目录。
 * 任一步失败即中断，错误文案直接面向面板用户。
 */
export async function applyUpdate(): Promise<UpdateApplyResult> {
    const from = String((packageJSON as any).version || '');
    try {
        const check = await checkForUpdate({ force: true });
        if (!check.ok || !check.latest) {
            return { ok: false, from, error: check.error || '拿不到远端版本号' };
        }
        const to = check.latest;
        const cfg = updateConfig();
        const repo = String(cfg.repo).trim();
        const branch = String(cfg.branch || 'main');
        const subdir = normalizeSubdir(cfg.subdir);

        // 1. 停掉 mcp-server 子进程，释放它占用的脚本文件
        try {
            await stopMcpServer();
        } catch (e) {
            // 没启动过也会走到这里，不阻塞更新
        }

        // 2. 下载分支 zip 到 <项目>/temp/cocos-mcp/update/
        const workDir = join(getLogDir(), 'update');
        const zipFile = join(workDir, `${branch}.zip`);
        await ensureDir(workDir);
        await downloadFile(`https://github.com/${repo}/archive/refs/heads/${branch}.zip`, zipFile, 60000);
        log('update-apply', { step: 'downloaded', zipFile, bytes: statSync(zipFile).size });

        // 3. 解压（GitHub zip 的根目录是 <repo名>-<branch>/）
        const extractDir = join(workDir, 'unpacked');
        await extractZip(zipFile, extractDir);

        // 4. 校验更新包：必须有 package.json 且版本不比当前旧
        const repoName = repo.split('/')[1];
        let srcExtDir = join(extractDir, `${repoName}-${branch}`);
        if (subdir) srcExtDir = join(srcExtDir, ...subdir.split('/'));
        const srcPkgFile = join(srcExtDir, 'package.json');
        if (!existsSync(srcPkgFile)) {
            throw new Error(`更新包里找不到 ${subdir ? subdir + '/' : ''}package.json（检查 update.subdir 配置是否与仓库目录结构一致）`);
        }
        const srcVersion = String(JSON.parse(readFileSync(srcPkgFile, 'utf8')).version || '');
        if (!srcVersion) throw new Error('更新包 package.json 缺少 version 字段');
        if (compareVersions(srcVersion, from) < 0) {
            throw new Error(`更新包版本 v${srcVersion} 比当前 v${from} 还旧，已中止覆盖`);
        }
        if (!existsSync(join(srcExtDir, 'dist', 'main.js'))) {
            throw new Error('更新包缺少 dist/main.js（发布时忘了提交编译产物？），已中止覆盖');
        }

        // 5. 覆盖扩展目录：优先整目录改名留备份，失败则原地覆盖
        const extDir = extensionDir();
        const backup = join(extDir, '..', `.${basename(extDir)}.bak-${timestampStamp()}`);
        let backupPath = '';
        let notice = '';
        try {
            await move(extDir, backup);
            backupPath = backup;
            try {
                await move(srcExtDir, extDir);
            } catch (e) {
                // 新目录移入失败：把旧目录滚回来，避免扩展直接丢失
                try {
                    await move(backup, extDir);
                } catch (e2) {
                    await copy(backup, extDir, { overwrite: true });
                }
                throw e;
            }
        } catch (e: any) {
            if (backupPath) {
                // 改名成功但移入/恢复失败：旧目录还在备份处，如实告知位置
                throw new Error(`更新失败，旧目录未能完全恢复（备份在 ${backupPath}）：${e && e.message ? e.message : e}`);
            }
            // Windows 偶发文件占用导致目录改名失败：退化为原地覆盖
            await copy(srcExtDir, extDir, { overwrite: true });
            notice = `旧目录无法改名备份（${e && e.message ? e.message : e}），已直接覆盖，个别旧文件可能残留`;
        }

        // 6. GitHub zip 里没有 node_modules 和 .git：从备份搬回来，
        //    否则面板因缺 fs-extra 加载失败、git 历史断连（原地覆盖路径这两样本来就在，会跳过）
        if (backupPath) {
            for (const keep of ['node_modules', '.git']) {
                const src = join(backup, keep);
                const dst = join(extDir, keep);
                if (!existsSync(dst) && existsSync(src)) {
                    try {
                        await move(src, dst);
                    } catch (e) {
                        try {
                            await copy(src, dst);
                        } catch (e2) {
                            notice += `${notice ? ' ' : ''}注意：${keep} 未能自动恢复，备份在 ${backup} 里。`;
                        }
                    }
                }
            }
        }

        // 7. 清理临时目录
        try {
            await remove(workDir);
        } catch (e) {
            // 留着也不影响，下次更新前会清
        }

        log('update-apply', { ok: true, from, to, backup: backupPath || '无（原地覆盖）' });
        return {
            ok: true,
            from,
            to,
            backup: backupPath || undefined,
            notice: notice ||
                '更新完成。扩展即将重载，MCP Server 需要在面板重新点「启动 MCP」。',
        };
    } catch (e: any) {
        const message = e && e.message ? e.message : String(e);
        log('update-apply', { error: message }, 'error');
        return { ok: false, from, error: message };
    }
}
