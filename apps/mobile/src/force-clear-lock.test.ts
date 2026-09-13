import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORCE_CLEAR_WARNING,
  HOLDER_ALIVE_CODE,
  holderAliveConfirmText,
  isHolderAliveError,
  isHolderAliveResponse,
  planForceClearRetry,
} from './force-clear-lock';

test('first force-clear warning tells users to prefer closing the desktop session', () => {
  assert.match(FORCE_CLEAR_WARNING, /仅删除当前会话的锁文件/);
  assert.match(FORCE_CLEAR_WARNING, /若桌面端或其codex进程仍在运行/);
  assert.match(FORCE_CLEAR_WARNING, /删锁可能导致并发写入\/会话损坏/);
  assert.match(FORCE_CLEAR_WARNING, /请优先在桌面关闭该会话或退出桌面/);
});

test('holder-alive confirm copy clearly lists the running desktop process and asks to re-confirm', () => {
  const text = holderAliveConfirmText('检测到 codex 进程 1234 仍在运行');
  assert.match(text, /检测到桌面进程仍在运行/);
  assert.match(text, /确定要强行删除请再确认/);
  assert.match(text, /检测到 codex 进程 1234 仍在运行/);
  const bare = holderAliveConfirmText('');
  assert.match(bare, /检测到桌面进程仍在运行/);
  assert.doesNotMatch(bare, /undefined/);
});

test('isHolderAliveResponse matches the 409 holder_alive contract payload', () => {
  assert.equal(isHolderAliveResponse({ error: 'holder_alive', holderAlive: true, message: 'still running' }), true);
  assert.equal(isHolderAliveResponse({ error: 'holder_alive' }), true);
  assert.equal(isHolderAliveResponse({ holderAlive: true }), true);
  assert.equal(isHolderAliveResponse({ error: '认证失败' }), false);
  assert.equal(isHolderAliveResponse({ holderAlive: false }), false);
  assert.equal(isHolderAliveResponse(null), false);
  assert.equal(isHolderAliveResponse(undefined), false);
});

test('isHolderAliveError recognises thrown errors carrying code/error/holderAlive fields', () => {
  const withCode = new Error('桌面进程仍在运行') as Error & { code?: string };
  withCode.code = HOLDER_ALIVE_CODE;
  assert.equal(isHolderAliveError(withCode), true);
  assert.equal(isHolderAliveError({ error: HOLDER_ALIVE_CODE }), true);
  assert.equal(isHolderAliveError({ holderAlive: true }), true);
  assert.equal(isHolderAliveError(new Error('普通失败')), false);
  assert.equal(isHolderAliveError({ code: 'other' }), false);
  assert.equal(isHolderAliveError('字符串'), false);
  assert.equal(isHolderAliveError(null), false);
  assert.equal(isHolderAliveError(undefined), false);
});

test('planForceClearRetry upgrades to a stronger confirmation only for the first holder_alive failure', () => {
  const holderAliveErr = Object.assign(new Error('桌面进程仍在运行'), { code: HOLDER_ALIVE_CODE });
  // 首次（未携带 acknowledgeHolderAlive）失败且为 holder_alive → 触发第二次更强确认
  assert.equal(planForceClearRetry(holderAliveErr, false), 'confirm-holder-alive');
  // 其他错误 → 按普通错误展示
  assert.equal(planForceClearRetry(new Error('认证失败'), false), 'show-error');
  assert.equal(planForceClearRetry(new Error('网络断开'), false), 'show-error');
  // 已携带 acknowledgeHolderAlive 的重试失败 → 不再确认，按普通错误展示
  assert.equal(planForceClearRetry(holderAliveErr, true), 'show-error');
});
