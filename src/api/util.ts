/**
 * 小工具。
 */

/**
 * 等一会儿（毫秒）。
 *
 * 守护进程的轮询、扩展自重载的等待、页面任务的节奏全靠它 ——
 * 之前每个文件各写一份 `new Promise((r) => setTimeout(r, ms))`。
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
