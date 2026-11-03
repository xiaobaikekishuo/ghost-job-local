export function sameConversation(expected, current) {
  if (!expected || !current || current.error) return false;
  const a = expected.remoteId || expected.id, b = current.remoteId || current.id;
  if (!a || !b || String(a) !== String(b)) return false;
  return ['contact', 'company', 'jobTitle', 'jobUrl'].every(key =>
    !expected[key] || !current[key] || expected[key].trim() === current[key].trim());
}
export function assertConversation(expected, current) {
  if (!sameConversation(expected, current)) throw Error('当前会话身份不一致，请重新同步后操作');
}
export function assertActive(active = () => true) {
  if (!active()) {
    const error = Error('操作已停止');
    error.code = 'CANCELLED';
    throw error;
  }
}
