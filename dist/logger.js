"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setLogDir = setLogDir;
exports.getLogDir = getLogDir;
exports.getLogFile = getLogFile;
exports.log = log;
const fs_1 = require("fs");
const path_1 = require("path");
/**
 * 日志工具：同时输出到编辑器控制台与本地文件。
 * 文件落在 <项目>/temp/cocos-mcp/ipc.log，方便用命令行核对每一步的结果。
 */
let cachedLogFile = '';
let logDirOverride = '';
/** 强制指定日志目录（面板进程用，因为面板拿到的 Editor API 可能不含 Project） */
function setLogDir(dir) {
    if (dir && dir !== logDirOverride) {
        logDirOverride = dir;
        cachedLogFile = '';
    }
}
function stringify(payload) {
    if (payload === undefined)
        return '';
    if (typeof payload === 'string')
        return payload;
    try {
        return JSON.stringify(payload, null, 2);
    }
    catch (e) {
        return String(payload);
    }
}
/**
 * 日志目录：<项目>/temp/cocos-mcp/
 *
 * 优先用 Editor.Project.path；拿不到时（例如面板进程、刚被重新 require 的模块副本）
 * 就从本模块自身位置往上数：<扩展>/dist/logger.js -> <项目>。
 * 保证主进程、面板进程、直连模式新加载的模块副本都写到同一个文件。
 */
function getLogDir() {
    var _a;
    if (logDirOverride)
        return logDirOverride;
    const editor = typeof Editor !== 'undefined' ? Editor : null;
    if ((_a = editor === null || editor === void 0 ? void 0 : editor.Project) === null || _a === void 0 ? void 0 : _a.path) {
        return (0, path_1.join)(editor.Project.path, 'temp', 'cocos-mcp');
    }
    return (0, path_1.join)(__dirname, '..', '..', '..', 'temp', 'cocos-mcp');
}
/** 日志文件路径 */
function getLogFile() {
    if (!cachedLogFile) {
        const dir = getLogDir();
        try {
            (0, fs_1.mkdirSync)(dir, { recursive: true });
        }
        catch (e) {
            // 目录创建失败不影响主流程
        }
        cachedLogFile = (0, path_1.join)(dir, 'ipc.log');
    }
    return cachedLogFile;
}
/**
 * 打印一条日志。
 * @param scope 作用域，例如 operations / scene-script
 * @param payload 附带数据（会被 JSON 序列化）
 * @param level info | warn | error
 */
function log(scope, payload, level = 'info') {
    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    const body = payload === undefined ? '' : `\n${stringify(payload)}`;
    const line = `[${time}] [${level.toUpperCase()}] [${scope}]${body}\n`;
    if (level === 'error') {
        console.error(line);
    }
    else if (level === 'warn') {
        console.warn(line);
    }
    else {
        console.log(line);
    }
    try {
        (0, fs_1.appendFileSync)(getLogFile(), line, 'utf8');
    }
    catch (e) {
        // 写文件失败不影响主流程
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9nZ2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc291cmNlL2xvZ2dlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQVlBLDhCQUtDO0FBbUJELDhCQU9DO0FBR0QsZ0NBV0M7QUFRRCxrQkFrQkM7QUFuRkQsMkJBQStDO0FBQy9DLCtCQUE0QjtBQUU1Qjs7O0dBR0c7QUFFSCxJQUFJLGFBQWEsR0FBRyxFQUFFLENBQUM7QUFDdkIsSUFBSSxjQUFjLEdBQUcsRUFBRSxDQUFDO0FBRXhCLHNEQUFzRDtBQUN0RCxTQUFnQixTQUFTLENBQUMsR0FBVztJQUNqQyxJQUFJLEdBQUcsSUFBSSxHQUFHLEtBQUssY0FBYyxFQUFFLENBQUM7UUFDaEMsY0FBYyxHQUFHLEdBQUcsQ0FBQztRQUNyQixhQUFhLEdBQUcsRUFBRSxDQUFDO0lBQ3ZCLENBQUM7QUFDTCxDQUFDO0FBRUQsU0FBUyxTQUFTLENBQUMsT0FBWTtJQUMzQixJQUFJLE9BQU8sS0FBSyxTQUFTO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFDckMsSUFBSSxPQUFPLE9BQU8sS0FBSyxRQUFRO1FBQUUsT0FBTyxPQUFPLENBQUM7SUFDaEQsSUFBSSxDQUFDO1FBQ0QsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLE9BQU8sRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFDNUMsQ0FBQztJQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7UUFDVCxPQUFPLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUMzQixDQUFDO0FBQ0wsQ0FBQztBQUVEOzs7Ozs7R0FNRztBQUNILFNBQWdCLFNBQVM7O0lBQ3JCLElBQUksY0FBYztRQUFFLE9BQU8sY0FBYyxDQUFDO0lBQzFDLE1BQU0sTUFBTSxHQUFHLE9BQU8sTUFBTSxLQUFLLFdBQVcsQ0FBQyxDQUFDLENBQUUsTUFBYyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDdEUsSUFBSSxNQUFBLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRSxPQUFPLDBDQUFFLElBQUksRUFBRSxDQUFDO1FBQ3hCLE9BQU8sSUFBQSxXQUFJLEVBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFLFdBQVcsQ0FBQyxDQUFDO0lBQzFELENBQUM7SUFDRCxPQUFPLElBQUEsV0FBSSxFQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsV0FBVyxDQUFDLENBQUM7QUFDbEUsQ0FBQztBQUVELGFBQWE7QUFDYixTQUFnQixVQUFVO0lBQ3RCLElBQUksQ0FBQyxhQUFhLEVBQUUsQ0FBQztRQUNqQixNQUFNLEdBQUcsR0FBRyxTQUFTLEVBQUUsQ0FBQztRQUN4QixJQUFJLENBQUM7WUFDRCxJQUFBLGNBQVMsRUFBQyxHQUFHLEVBQUUsRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztRQUN4QyxDQUFDO1FBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUNULGVBQWU7UUFDbkIsQ0FBQztRQUNELGFBQWEsR0FBRyxJQUFBLFdBQUksRUFBQyxHQUFHLEVBQUUsU0FBUyxDQUFDLENBQUM7SUFDekMsQ0FBQztJQUNELE9BQU8sYUFBYSxDQUFDO0FBQ3pCLENBQUM7QUFFRDs7Ozs7R0FLRztBQUNILFNBQWdCLEdBQUcsQ0FBQyxLQUFhLEVBQUUsT0FBYSxFQUFFLFFBQW1DLE1BQU07SUFDdkYsTUFBTSxJQUFJLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQyxjQUFjLENBQUMsT0FBTyxFQUFFLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7SUFDbkUsTUFBTSxJQUFJLEdBQUcsT0FBTyxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxLQUFLLFNBQVMsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO0lBQ3BFLE1BQU0sSUFBSSxHQUFHLElBQUksSUFBSSxNQUFNLEtBQUssQ0FBQyxXQUFXLEVBQUUsTUFBTSxLQUFLLElBQUksSUFBSSxJQUFJLENBQUM7SUFFdEUsSUFBSSxLQUFLLEtBQUssT0FBTyxFQUFFLENBQUM7UUFDcEIsT0FBTyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN4QixDQUFDO1NBQU0sSUFBSSxLQUFLLEtBQUssTUFBTSxFQUFFLENBQUM7UUFDMUIsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN2QixDQUFDO1NBQU0sQ0FBQztRQUNKLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDdEIsQ0FBQztJQUVELElBQUksQ0FBQztRQUNELElBQUEsbUJBQWMsRUFBQyxVQUFVLEVBQUUsRUFBRSxJQUFJLEVBQUUsTUFBTSxDQUFDLENBQUM7SUFDL0MsQ0FBQztJQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7UUFDVCxjQUFjO0lBQ2xCLENBQUM7QUFDTCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgYXBwZW5kRmlsZVN5bmMsIG1rZGlyU3luYyB9IGZyb20gJ2ZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJztcblxuLyoqXG4gKiDml6Xlv5flt6XlhbfvvJrlkIzml7bovpPlh7rliLDnvJbovpHlmajmjqfliLblj7DkuI7mnKzlnLDmlofku7bjgIJcbiAqIOaWh+S7tuiQveWcqCA86aG555uuPi90ZW1wL2NvY29zLW1jcC9pcGMubG9n77yM5pa55L6/55So5ZG95Luk6KGM5qC45a+55q+P5LiA5q2l55qE57uT5p6c44CCXG4gKi9cblxubGV0IGNhY2hlZExvZ0ZpbGUgPSAnJztcbmxldCBsb2dEaXJPdmVycmlkZSA9ICcnO1xuXG4vKiog5by65Yi25oyH5a6a5pel5b+X55uu5b2V77yI6Z2i5p2/6L+b56iL55So77yM5Zug5Li66Z2i5p2/5ou/5Yiw55qEIEVkaXRvciBBUEkg5Y+v6IO95LiN5ZCrIFByb2plY3TvvIkgKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRMb2dEaXIoZGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoZGlyICYmIGRpciAhPT0gbG9nRGlyT3ZlcnJpZGUpIHtcbiAgICAgICAgbG9nRGlyT3ZlcnJpZGUgPSBkaXI7XG4gICAgICAgIGNhY2hlZExvZ0ZpbGUgPSAnJztcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHN0cmluZ2lmeShwYXlsb2FkOiBhbnkpOiBzdHJpbmcge1xuICAgIGlmIChwYXlsb2FkID09PSB1bmRlZmluZWQpIHJldHVybiAnJztcbiAgICBpZiAodHlwZW9mIHBheWxvYWQgPT09ICdzdHJpbmcnKSByZXR1cm4gcGF5bG9hZDtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkocGF5bG9hZCwgbnVsbCwgMik7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICByZXR1cm4gU3RyaW5nKHBheWxvYWQpO1xuICAgIH1cbn1cblxuLyoqXG4gKiDml6Xlv5fnm67lvZXvvJo86aG555uuPi90ZW1wL2NvY29zLW1jcC9cbiAqXG4gKiDkvJjlhYjnlKggRWRpdG9yLlByb2plY3QucGF0aO+8m+aLv+S4jeWIsOaXtu+8iOS+i+Wmgumdouadv+i/m+eoi+OAgeWImuiiq+mHjeaWsCByZXF1aXJlIOeahOaooeWdl+WJr+acrO+8iVxuICog5bCx5LuO5pys5qih5Z2X6Ieq6Lqr5L2N572u5b6A5LiK5pWw77yaPOaJqeWxlT4vZGlzdC9sb2dnZXIuanMgLT4gPOmhueebrj7jgIJcbiAqIOS/neivgeS4u+i/m+eoi+OAgemdouadv+i/m+eoi+OAgeebtOi/nuaooeW8j+aWsOWKoOi9veeahOaooeWdl+WJr+acrOmDveWGmeWIsOWQjOS4gOS4quaWh+S7tuOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0TG9nRGlyKCk6IHN0cmluZyB7XG4gICAgaWYgKGxvZ0Rpck92ZXJyaWRlKSByZXR1cm4gbG9nRGlyT3ZlcnJpZGU7XG4gICAgY29uc3QgZWRpdG9yID0gdHlwZW9mIEVkaXRvciAhPT0gJ3VuZGVmaW5lZCcgPyAoRWRpdG9yIGFzIGFueSkgOiBudWxsO1xuICAgIGlmIChlZGl0b3I/LlByb2plY3Q/LnBhdGgpIHtcbiAgICAgICAgcmV0dXJuIGpvaW4oZWRpdG9yLlByb2plY3QucGF0aCwgJ3RlbXAnLCAnY29jb3MtbWNwJyk7XG4gICAgfVxuICAgIHJldHVybiBqb2luKF9fZGlybmFtZSwgJy4uJywgJy4uJywgJy4uJywgJ3RlbXAnLCAnY29jb3MtbWNwJyk7XG59XG5cbi8qKiDml6Xlv5fmlofku7bot6/lvoQgKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRMb2dGaWxlKCk6IHN0cmluZyB7XG4gICAgaWYgKCFjYWNoZWRMb2dGaWxlKSB7XG4gICAgICAgIGNvbnN0IGRpciA9IGdldExvZ0RpcigpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIOebruW9leWIm+W7uuWksei0peS4jeW9seWTjeS4u+a1geeoi1xuICAgICAgICB9XG4gICAgICAgIGNhY2hlZExvZ0ZpbGUgPSBqb2luKGRpciwgJ2lwYy5sb2cnKTtcbiAgICB9XG4gICAgcmV0dXJuIGNhY2hlZExvZ0ZpbGU7XG59XG5cbi8qKlxuICog5omT5Y2w5LiA5p2h5pel5b+X44CCXG4gKiBAcGFyYW0gc2NvcGUg5L2c55So5Z+f77yM5L6L5aaCIG9wZXJhdGlvbnMgLyBzY2VuZS1zY3JpcHRcbiAqIEBwYXJhbSBwYXlsb2FkIOmZhOW4puaVsOaNru+8iOS8muiiqyBKU09OIOW6j+WIl+WMlu+8iVxuICogQHBhcmFtIGxldmVsIGluZm8gfCB3YXJuIHwgZXJyb3JcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvZyhzY29wZTogc3RyaW5nLCBwYXlsb2FkPzogYW55LCBsZXZlbDogJ2luZm8nIHwgJ3dhcm4nIHwgJ2Vycm9yJyA9ICdpbmZvJyk6IHZvaWQge1xuICAgIGNvbnN0IHRpbWUgPSBuZXcgRGF0ZSgpLnRvTG9jYWxlU3RyaW5nKCd6aC1DTicsIHsgaG91cjEyOiBmYWxzZSB9KTtcbiAgICBjb25zdCBib2R5ID0gcGF5bG9hZCA9PT0gdW5kZWZpbmVkID8gJycgOiBgXFxuJHtzdHJpbmdpZnkocGF5bG9hZCl9YDtcbiAgICBjb25zdCBsaW5lID0gYFske3RpbWV9XSBbJHtsZXZlbC50b1VwcGVyQ2FzZSgpfV0gWyR7c2NvcGV9XSR7Ym9keX1cXG5gO1xuXG4gICAgaWYgKGxldmVsID09PSAnZXJyb3InKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IobGluZSk7XG4gICAgfSBlbHNlIGlmIChsZXZlbCA9PT0gJ3dhcm4nKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihsaW5lKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmxvZyhsaW5lKTtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgICBhcHBlbmRGaWxlU3luYyhnZXRMb2dGaWxlKCksIGxpbmUsICd1dGY4Jyk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAvLyDlhpnmlofku7blpLHotKXkuI3lvbHlk43kuLvmtYHnqItcbiAgICB9XG59XG4iXX0=