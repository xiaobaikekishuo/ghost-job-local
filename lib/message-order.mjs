// A visible page index is never a conversation-wide sequence number.
export function messageTime(message) {
  const value = message.sourceTime || message.sentAt || message.time;
  if (!value) return null;
  if (/^\d{10,13}$/.test(String(value))) return Number(value) * (String(value).length === 10 ? 1000 : 1);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
export function orderedMessages(messages) {
  return [...messages].sort((a, b) => {
    if (Number.isFinite(a.order) && Number.isFinite(b.order)) return a.order - b.order || a.id - b.id;
    const ta = messageTime(a), tb = messageTime(b);
    return ta !== null && tb !== null && ta !== tb ? ta - tb : (a.id || 0) - (b.id || 0);
  });
}
// Merge overlapping visible windows by stable message IDs. With no overlap,
// use source timestamps; an undated live increment is appended, not reset to 0.
export function mergeMessageOrder(existing, incoming) {
  const result = orderedMessages(existing);
  let previous = null;
  for (let i = 0; i < incoming.length; i++) {
    const message = incoming[i];
    if (result.some(m => m.id === message.id)) { previous = message.id; continue; }
    const next = incoming.slice(i + 1).find(m => result.some(old => old.id === m.id));
    let index = next ? result.findIndex(m => m.id === next.id) : -1;
    if (index < 0 && previous !== null) index = result.findIndex(m => m.id === previous) + 1;
    if (index < 0) {
      const time = messageTime(message);
      index = time === null ? -1 : result.findIndex(m => messageTime(m) !== null && messageTime(m) > time);
    }
    result.splice(index < 0 ? result.length : index, 0, message);
    previous = message.id;
  }
  return result;
}
