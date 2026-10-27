#!/usr/bin/env node
/**
 * 打包发布 zip：node scripts/pack.js [--no-build] [--no-node-modules]
 *
 * 产物：<扩展>/release/cocos-mcp-v<version>.zip，zip 内是单个 cocos-mcp/ 目录，
 * 用户解压到 <项目>/extensions/ 即完成安装（dist 已随包带上，无需再编译）。
 *
 * 打包内容 = 运行必需 + 文档 + 生产依赖闭包（fs-extra 一族，纯 JS 可跨平台）。
 * 刻意不带：source/ tsconfig @types（开发用）、typescript/@cocos 等 devDependencies。
 *
 * 注意：发布前先在 package.json bump version 再打包——version 会被 tsc 内联进 dist，
 * 打包脚本默认先跑 npm run build 保证 dist 与当前源码/配置一致。
 */
const { join } = require('path');
const { existsSync, statSync } = require('fs');
const fse = require('fs-extra');
const { spawnSync } = require('child_process');

const args = new Set(process.argv.slice(2));
const extRoot = join(__dirname, '..');
const pkg = JSON.parse(fse.readFileSync(join(extRoot, 'package.json'), 'utf8'));
const version = String(pkg.version || '0.0.0');

const outDir = join(extRoot, 'release');
const stage = join(outDir, 'stage');
const stageExt = join(stage, 'cocos-mcp');
const zipName = `cocos-mcp-v${version}.zip`;
const zipPath = join(outDir, zipName);

/** 收集生产依赖闭包（沿 dependencies 递归；npm 平铺安装，够用） */
function collectProdDeps(names, acc) {
    for (const name of names) {
        if (acc.has(name)) continue;
        const pkgFile = join(extRoot, 'node_modules', name, 'package.json');
        if (!existsSync(pkgFile)) {
            console.warn(`[pack] 警告：node_modules 里找不到 ${name}，先在扩展目录 npm install`);
            continue;
        }
        acc.add(name);
        const child = JSON.parse(fse.readFileSync(pkgFile, 'utf8'));
        collectProdDeps(Object.keys(child.dependencies || {}), acc);
    }
    return acc;
}

function fail(message) {
    console.error(`[pack] ${message}`);
    try { fse.removeSync(stage); } catch (e) { /* 忽略 */ }
    process.exit(1);
}

// 1. 编译（--no-build 跳过；但 dist 必须存在）
if (!args.has('--no-build')) {
    console.log('[pack] npm run build ...');
    const r = spawnSync('npx', ['tsc'], { cwd: extRoot, stdio: 'inherit', shell: true });
    if (r.status !== 0) fail(`编译失败（exit ${r.status}），中止打包`);
} else if (!existsSync(join(extRoot, 'dist', 'main.js'))) {
    fail('dist/main.js 不存在，先 npm run build（或去掉 --no-build）');
}

// 2. 组装清单
const items = ['package.json', 'package-lock.json', 'dist', 'mcp-server', 'static', 'i18n', 'scripts', 'README.md', 'README.en.md']
    .filter((p) => existsSync(join(extRoot, p)));
const missingMust = ['package.json', 'dist', 'mcp-server', 'static', 'i18n'].filter((p) => !items.includes(p));
if (missingMust.length) fail(`缺少打包必需项：${missingMust.join('、')}`);

let prodDeps = new Set();
if (!args.has('--no-node-modules')) {
    prodDeps = collectProdDeps(Object.keys(pkg.dependencies || {}), new Set());
    console.log(`[pack] 携带生产依赖：${[...prodDeps].join('、') || '（无）'}`);
}

// 3. 复制到 stage：zip 根是单个 cocos-mcp/ 目录
fse.removeSync(outDir);
fse.ensureDirSync(stageExt);
for (const item of items) {
    fse.copySync(join(extRoot, item), join(stageExt, item));
}
for (const name of prodDeps) {
    fse.copySync(join(extRoot, 'node_modules', name), join(stageExt, 'node_modules', name));
}

// 4. 压 zip：System32 bsdtar（-a 按扩展名出 zip）→ PATH tar → PowerShell Compress-Archive
const attempts = [];
const tarArgs = ['-a', '-cf', zipPath, '-C', stage, 'cocos-mcp'];
if (process.platform === 'win32') {
    attempts.push({ cmd: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), args: tarArgs });
    attempts.push({ cmd: 'powershell', encoded: `Compress-Archive -Path "${stageExt}" -DestinationPath "${zipPath}" -Force` });
    attempts.push({ cmd: 'tar', args: tarArgs });
} else {
    attempts.push({ cmd: 'tar', args: tarArgs });
    attempts.push({ cmd: 'zip', args: ['-r', '-q', zipPath, 'cocos-mcp'], cwd: stage });
}

let ok = false;
const errors = [];
for (const a of attempts) {
    const r = a.encoded
        ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(a.encoded, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8' })
        : spawnSync(a.cmd, a.args, { cwd: a.cwd || extRoot, windowsHide: true, encoding: 'utf8' });
    if (!r.error && r.status === 0 && existsSync(zipPath)) {
        ok = true;
        break;
    }
    errors.push(`${a.cmd}: ${r.error ? r.error.code : `exit ${r.status}`} ${(r.stderr || '').slice(0, 200)}`);
}
if (!ok) fail(`打 zip 失败（bsdtar/PowerShell 都不可用）：\n${errors.join('\n')}`);

// 5. 清理 stage，报告
fse.removeSync(stage);
const mb = (statSync(zipPath).size / 1024 / 1024).toFixed(2);
console.log(`[pack] 完成：${zipPath}（${mb} MB）`);
console.log('[pack] zip 内是单个 cocos-mcp/ 目录，上传 GitHub Release 后用户解压到 <项目>/extensions/ 即装好。');
