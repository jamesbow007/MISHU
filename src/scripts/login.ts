/**
 * 登录：打开 BOSS直聘 登录页，扫码即可。
 *
 * 为什么不用 Node 侧扫码：登录凭据由浏览器持有 —— 扫码成功后浏览器自己
 * 写入 cookie，扩展立刻就能用它发请求。Node 再存一份只会和扩展推来的
 * cookie 互相覆盖（扩展只看得见 bst 一条），反而把登录态搞乱。
 *
 * 用法：npm run login
 */
import { execSync } from 'node:child_process';

const LOGIN_URL = 'https://www.zhipin.com/web/user/?ka=header-login';

async function main() {
  console.log('打开 BOSS直聘 登录页…');
  try {
    execSync(`start "" "${LOGIN_URL}"`, { stdio: 'ignore', windowsHide: true });
  } catch {
    console.log(`请手动在浏览器中打开：${LOGIN_URL}`);
  }

  console.log('');
  console.log('用手机 BOSS直聘 扫码登录即可 —— 登录态由浏览器保存，扩展会自动使用。');
  console.log('注意：登录的那个浏览器窗口不要关，扩展需要从中发请求。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
