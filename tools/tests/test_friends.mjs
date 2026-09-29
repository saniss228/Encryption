/* Друзья и блокировки: правило «писать можно только друзьям».
 *
 * Проверяем по-настоящему серверные правила:
 *   1. незнакомцу написать нельзя (403 NOT_FRIENDS), чат при этом создаётся;
 *   2. заявка → принятие → переписка работает;
 *   3. заявку можно отклонить и отменить;
 *   4. блокировка обрывает переписку и звонки, разблокировка не возвращает дружбу.
 */
import fs from 'fs'; import vm from 'vm';
const ctx = { crypto: globalThis.crypto, btoa, atob, TextEncoder, TextDecoder, console, fetch, setTimeout, Date };
ctx.self = ctx; ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync((process.env.ENC_ROOT || '.') + '/web/js/crypto.js', 'utf8'), ctx);
const C = ctx.Crypto;
const BASE = process.env.ENC_BASE || 'http://127.0.0.1:8031';
const SUF = Math.random().toString(16).slice(2, 7);
const U = (n) => n + SUF;
const j = async (m, p, b, tok) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null } catch (e) { d = t }
  const code = (d && ((d.error && d.error.code) || (d.detail && d.detail.code))) || undefined;
  return { status: r.status, data: d, code };
};
const dev = (n) => ({ device_id: 'fr-device-' + n + '-' + Math.random().toString(16).slice(2, 8), name: 'Тест ' + n, platform: 'web', app_version: '1.0.0', fingerprint: 'fp' + n });

let ok = 0, bad = 0;
const check = (name, cond, extra) => { console.log((cond ? '  ✅ ' : '  ✗ ') + name + (extra !== undefined ? '   ' + extra : '')); cond ? ok++ : bad++; };

async function person(latin, display) {
  const id = await C.generateIdentity();
  const uname = U(latin);
  const reg = await j('POST', '/api/v1/auth/register', {
    username: uname, display_name: display, auth_hash: await C.authHash(uname, 'pass12345'),
    keys: C.publicBundle(id), device: dev(latin.slice(0, 3)),
    key_backup: await C.wrapWithPassword(uname, 'pass12345', id),
  });
  if (reg.status !== 201) throw new Error('регистрация ' + display + ': ' + JSON.stringify(reg.data));
  id.userId = reg.data.user.id;
  return { id, tok: reg.data.tokens.access_token, username: uname, display };
}

async function message(who, peer, chatId, text) {
  const recipients = [
    { id: who.id.userId, rsa_pub: who.id.rsa.pub, ik_dh_pub: who.id.dh.pub },
    { id: peer.id.userId, rsa_pub: peer.id.rsa.pub, ik_dh_pub: peer.id.dh.pub },
  ];
  const env = await C.seal({ text, ts: Date.now(), from: who.username }, who.id, recipients, chatId, { ts: Math.floor(Date.now() / 1000) });
  return j('POST', '/api/v1/messages', { chat_id: chatId, payload: env, type: 'text' }, who.tok);
}

console.log('── 1. Незнакомцу писать нельзя ──');
const alice = await person('alice', 'Алиса');
const bob = await person('bob', 'Боб');
const carol = await person('carol', 'Кэрол');

const chat = await j('POST', '/api/v1/chats', { type: 'direct', peer_username: bob.username }, alice.tok);
check('чат с незнакомцем создаётся', chat.status === 201, 'чат ' + chat.data.id);
const chatId = chat.data.id;
const noFriend = await message(alice, bob, chatId, 'привет незнакомцу');
check('сообщение незнакомцу → 403 NOT_FRIENDS', noFriend.status === 403 && noFriend.code === 'NOT_FRIENDS', noFriend.status + ' ' + noFriend.code);

console.log('── 2. Поиск показывает отношения ──');
const found = await j('GET', '/api/v1/users/search?q=' + bob.username.slice(0, 6), null, alice.tok);
const foundBob = (found.data.users || []).find((u) => u.username === bob.username);
check('в поиске есть поле relation', !!foundBob && foundBob.relation === 'none', foundBob && foundBob.relation);

console.log('── 3. Заявка в друзья → принятие → переписка ──');
const req = await j('POST', '/api/v1/friends/requests', { username: bob.username, message: 'Привет, это Алиса' }, alice.tok);
check('заявка отправлена', req.status === 201 && !!req.data.request, req.status);
const dup = await j('POST', '/api/v1/friends/requests', { username: bob.username }, alice.tok);
check('повторная заявка → 409', dup.status === 409, dup.status);

const bobList = await j('GET', '/api/v1/friends', null, bob.tok);
check('Боб видит входящую заявку', bobList.data.incoming.length === 1, JSON.stringify(bobList.data.incoming[0] || {}).slice(0, 60));
const aliceList = await j('GET', '/api/v1/friends', null, alice.tok);
check('Алиса видит исходящую заявку', aliceList.data.outgoing.length === 1);
check('друзей пока нет', aliceList.data.friends.length === 0 && bobList.data.friends.length === 0);

const rid = bobList.data.incoming[0].id;
const accepted = await j('POST', `/api/v1/friends/requests/${rid}/accept`, {}, bob.tok);
check('Боб принял заявку', accepted.status === 200 && !!accepted.data.friend, accepted.status);
const aAfter = await j('GET', '/api/v1/friends', null, alice.tok);
const bAfter = await j('GET', '/api/v1/friends', null, bob.tok);
check('дружба взаимная у обоих', aAfter.data.friends.length === 1 && bAfter.data.friends.length === 1,
  aAfter.data.friends.length + '/' + bAfter.data.friends.length);
check('заявка исчезла из списков', aAfter.data.outgoing.length === 0 && bAfter.data.incoming.length === 0);

const sent = await message(alice, bob, chatId, 'теперь можно писать');
check('сообщение другу отправлено', sent.status === 201, sent.status);
const inbox = await j('GET', '/api/v1/messages?chat_id=' + chatId, null, bob.tok);
const opened = await C.open(inbox.data.messages[0].payload, bob.id, alice.id.sign.pub, chatId);
check('Боб расшифровал сообщение', opened.plain.text === 'теперь можно писать', JSON.stringify(opened.plain.text));

console.log('── 4. Отклонение заявки ──');
const req2 = await j('POST', '/api/v1/friends/requests', { username: carol.username }, alice.tok);
const carolList = await j('GET', '/api/v1/friends', null, carol.tok);
const declined = await j('POST', `/api/v1/friends/requests/${carolList.data.incoming[0].id}/decline`, {}, carol.tok);
check('заявка отклонена', declined.status === 200, declined.status);
const carolChat = await j('POST', '/api/v1/chats', { type: 'direct', peer_username: carol.username }, alice.tok);
const toCarol = await message(alice, carol, carolChat.data.id, 'после отказа');
check('после отказа писать нельзя', toCarol.status === 403 && toCarol.code === 'NOT_FRIENDS', toCarol.status + ' ' + toCarol.code);

console.log('── 5. Отмена своей заявки ──');
const req3 = await j('POST', '/api/v1/friends/requests', { username: carol.username }, alice.tok);
const cancelled = await j('DELETE', '/api/v1/friends/requests/' + req3.data.request.id, null, alice.tok);
const carolAfter = await j('GET', '/api/v1/friends', null, carol.tok);
check('заявку можно отменить', cancelled.status === 200 && carolAfter.data.incoming.length === 0, cancelled.status);

console.log('── 6. Блокировка и разблокировка ──');
const blocked = await j('POST', `/api/v1/friends/${alice.id.userId}/block`, {}, bob.tok);
check('Боб заблокировал Алису', blocked.status === 200, blocked.status);
const aliceBlocked = await j('GET', '/api/v1/friends', null, alice.tok);
check('у Алисы больше нет друга', aliceBlocked.data.friends.length === 0);
const blockedMsg = await message(alice, bob, chatId, 'после блокировки');
check('сообщение при блокировке → 403 BLOCKED', blockedMsg.status === 403 && blockedMsg.code === 'BLOCKED', blockedMsg.status + ' ' + blockedMsg.code);
const callTry = await j('POST', '/api/v1/calls', { chat_id: chatId, kind: 'audio' }, alice.tok);
check('звонок при блокировке → 403', callTry.status === 403 && callTry.code === 'BLOCKED', callTry.status + ' ' + callTry.code);
const newReq = await j('POST', '/api/v1/friends/requests', { username: bob.username }, alice.tok);
check('заявка при блокировке → 403', newReq.status === 403, newReq.status);
const bBlocked = await j('GET', '/api/v1/friends', null, bob.tok);
check('у Боба видно блокировку', bBlocked.data.blocked.length === 1, JSON.stringify(bBlocked.data.blocked[0] || {}).slice(0, 40));
const searchBlocked = await j('GET', '/api/v1/users/search?q=' + alice.username.slice(0, 6), null, bob.tok);
const sb = (searchBlocked.data.users || []).find((u) => u.username === alice.username);
check('поиск показывает relation=blocked', !!(sb && sb.relation === 'blocked'), sb && sb.relation);

const unblocked = await j('POST', `/api/v1/friends/${alice.id.userId}/unblock`, {}, bob.tok);
check('разблокировка', unblocked.status === 200, unblocked.status);
const stillNotFriends = await message(alice, bob, chatId, 'после разблокировки');
check('после разблокировки нужна новая заявка', stillNotFriends.status === 403 && stillNotFriends.code === 'NOT_FRIENDS', stillNotFriends.status + ' ' + stillNotFriends.code);

console.log('── 7. Себя добавить нельзя ──');
const self = await j('POST', '/api/v1/friends/requests', { username: alice.username }, alice.tok);
check('заявка себе → 400', self.status === 400, self.status);

console.log('\nПройдено: ' + ok + '   Провалено: ' + bad);
process.exit(bad ? 1 : 0);
