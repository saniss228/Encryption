/* ============================================================================
 * Звонки: WebRTC (медиапоток DTLS-SRTP), сигнализация — поверх уже
 * зашифрованного WebSocket-канала. Поддержка аудио, видео, шаринга экрана.
 *
 * Порядок установления связи:
 *   1. звонящий отправляет приглашение и ждёт;
 *   2. вызываемый видит окно с кнопками «Принять» и «Отклонить»;
 *   3. после согласия звонящий отправляет предложение (offer), вызываемый
 *      отвечает (answer) — до этого микрофон и камера не включаются.
 * ========================================================================== */
(function (global) {
  'use strict';
  const { $, toast } = UI;
  const T = (k, v) => (window.I18N ? I18N.t(k, v) : k);

  const Call = {
    pc: null,
    localStream: null,
    screenStream: null,
    callId: null,
    chatId: null,
    kind: 'audio',
    peerId: null,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    active: false,
    waiting: false,         // входящий звонок ждёт решения пользователя
    mediaReady: false,      // согласие уже дано
    muted: false,
    videoOn: false,

    isOpen() {
      return !!$('callOverlay') && !$('callOverlay').classList.contains('hidden');
    },

    /* ── Оформление окна ─────────────────────────────────────────────────── */
    show({ peerName, state, incoming, accepted }) {
      $('callPeer').textContent = peerName || T('call.title');
      $('callState').textContent = state || '';
      $('callOverlay').classList.remove('hidden');
      $('callIncomingActions').classList.toggle('hidden', !incoming);
      $('callControls').classList.toggle('hidden', !!incoming);
      const remote = $('callRemote'), local = $('callLocal');
      // Пока нет согласия — не отвлекаем большим чёрным прямоугольником
      remote.style.display = accepted ? '' : 'none';
      local.style.display = accepted ? '' : 'none';
      $('callMute').textContent = '🎙';
      $('callVideoToggle').textContent = '🎥';
    },

    /* ── Исходящий звонок ────────────────────────────────────────────────── */
    async start(chatId, kind) {
      const App = global.App;
      const chat = App.chatsById[chatId];
      if (!chat) return toast(T('call.needChat'), 'err');
      if (chat.type === 'group') toast(T('call.groupStarted'), '', 3000);
      const peer = (chat.members || []).find((m) => m.id !== App.user.id);
      this.chatId = chatId;
      this.kind = kind;
      this.peerId = peer ? peer.id : null;
      this.waiting = false;
      this.mediaReady = false;
      try {
        const res = await App.api.post('/api/v1/calls', { chat_id: chatId, kind });
        this.callId = res.call_id;
        if (res.ice_servers) this.iceServers = res.ice_servers;
      } catch (e) {
        if (window.Log) window.Log.warn('call', 'сервер не разрешил звонок', { код: e && e.code, сообщение: e && e.message });
        // Пользователь заблокирован — сервер отказывает ещё до звонка
        if (e && e.code === 'BLOCKED') return toast(T('call.needFriends'), 'err', 6000);
        this.callId = 'local-' + Date.now();
      }
      this.show({ peerName: chat.title || (peer ? (peer.display_name || peer.username) : T('call.title')),
        state: T('call.calling'), incoming: false, accepted: false });
      App.api.sendRaw({ t: 'call.invite', chat_id: chatId, call_id: this.callId, kind });
      this.active = true;
      if (!App.api.connected && !App.demo) $('callState').textContent = T('app.offline');
    },

    /* ── Входящий звонок: спрашиваем пользователя ────────────────────────── */
    async incoming(ev) {
      const App = global.App;
      if (this.isOpen()) return;              // уже заняты другим звонком
      this.chatId = ev.chat_id;
      this.callId = ev.call_id;
      this.peerId = ev.from;
      this.kind = ev.kind || 'audio';
      this.waiting = true;
      this.mediaReady = false;
      if (window.Log) window.Log.info('call', 'входящий звонок', { id: ev.call_id, вид: ev.kind, от: ev.from });
      const chat = App.chatsById[ev.chat_id] || {};
      const peer = (chat.members || []).find((m) => m.id === ev.from) || {};
      this.show({
        peerName: peer.display_name || peer.username || T('call.incoming'),
        state: (ev.kind === 'video' ? T('call.incomingVideo') : T('call.incomingAudio')),
        incoming: true, accepted: false,
      });
      toast(T('call.incomingToast'), '', 6000);
    },

    /* ── Кнопка «Принять» ────────────────────────────────────────────────── */
    async accept() {
      const App = global.App;
      if (!this.callId) return;
      if (window.Log) window.Log.info('call', 'звонок принят', { id: this.callId });
      this.waiting = false;
      this.mediaReady = true;
      $('callIncomingActions').classList.add('hidden');
      $('callControls').classList.remove('hidden');
      $('callRemote').style.display = '';
      $('callLocal').style.display = '';
      $('callState').textContent = T('call.connecting');
      await this.prepareMedia(this.kind !== 'audio');
      await this.createPeer();
      App.api.sendRaw({ t: 'call.signal', to: this.peerId, call_id: this.callId, kind: this.kind, signal: 'accept' });
      this.active = true;
    },

    /* ── Кнопка «Отклонить» ──────────────────────────────────────────────── */
    decline() {
      const App = global.App;
      if (window.Log) window.Log.info('call', 'звонок отклонён', { id: this.callId });
      if (!this.callId) return this.cleanup();
      App.api.sendRaw({ t: 'call.signal', to: this.peerId, call_id: this.callId, signal: 'decline' });
      try { App.api.patch('/api/v1/calls/' + this.callId, { state: 'declined' }).catch(() => {}); } catch (e) {}
      this.cleanup();
    },

    /* ── Сигнализация ────────────────────────────────────────────────────── */
    async signal(ev) {
      const App = global.App;
      if (ev.call_id && this.callId && ev.call_id !== this.callId && ev.signal === 'accept') {
        this.callId = ev.call_id; this.chatId = ev.chat_id || this.chatId; this.peerId = ev.from;
      }
      if (!this.isOpen()) return;
      try {
        if (ev.signal === 'accept') {
          // Согласие получено: теперь можно включать камеру/микрофон и звонить
          this.waiting = false;
          this.mediaReady = true;
          await this.prepareMedia(this.kind !== 'audio');
          await this.createPeer();
          const offer = await this.pc.createOffer({
            offerToReceiveAudio: true, offerToReceiveVideo: this.kind !== 'audio',
          });
          await this.pc.setLocalDescription(offer);
          App.api.sendRaw({ t: 'call.signal', to: this.peerId, call_id: this.callId, kind: this.kind,
            signal: 'offer', sdp: this.pc.localDescription });
          $('callState').textContent = T('call.accepted');
        } else if (ev.signal === 'decline') {
          $('callState').textContent = T('call.declined');
          setTimeout(() => this.cleanup(), 900);
        } else if (ev.signal === 'offer') {
          if (this.waiting) return;           // не приняли — не отвечаем
          if (!this.pc) { await this.prepareMedia(ev.kind !== 'audio'); await this.createPeer(); }
          await this.pc.setRemoteDescription(new RTCSessionDescription(ev.sdp));
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          App.api.sendRaw({ t: 'call.signal', to: ev.from, call_id: this.callId, signal: 'answer', sdp: this.pc.localDescription });
          $('callState').textContent = T('call.inCall');
          this.active = true;
        } else if (ev.signal === 'answer') {
          await this.pc.setRemoteDescription(new RTCSessionDescription(ev.sdp));
          $('callState').textContent = T('call.inCall');
        } else if (ev.signal === 'ice' && ev.ice) {
          await this.pc.addIceCandidate(new RTCIceCandidate(ev.ice));
        } else if (ev.signal === 'hangup') {
          this.cleanup();
        }
      } catch (e) { console.warn('call signal', e); }
    },

    state(ev) {
      if (ev.call_id !== this.callId) return;
      if (ev.state === 'ended' || ev.state === 'declined' || ev.state === 'missed') {
        $('callState').textContent = ev.state === 'declined' ? T('call.declined')
          : (ev.state === 'missed' ? T('call.missed') : T('call.ended'));
        setTimeout(() => this.cleanup(), 900);
      } else if (ev.state === 'active') $('callState').textContent = T('call.inCall');
    },

    async prepareMedia(video) {
      if (this.localStream) return;
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw Object.assign(new Error(T('call.noMic')), { code: 'NO_MEDIA_API' });
        }
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!video });
      } catch (e) {
        try { this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e2) { toast(T('call.noMic'), 'err'); }
      }
      if (this.localStream) {
        $('callLocal').srcObject = this.localStream;
        this.videoOn = this.localStream.getVideoTracks().length > 0;
        $('callVideoToggle').textContent = this.videoOn ? '🎥' : '🚫';
      }
    },

    async createPeer() {
      if (this.pc) return;
      const App = global.App;
      this.pc = new RTCPeerConnection({ iceServers: this.iceServers });
      if (this.localStream) this.localStream.getTracks().forEach((t) => this.pc.addTrack(t, this.localStream));
      this.pc.ontrack = (e) => {
        $('callRemote').srcObject = e.streams[0];
        $('callState').textContent = T('call.inCall');
      };
      this.pc.onicecandidate = (e) => {
        if (e.candidate) {
          App.api.sendRaw({ t: 'call.signal', to: this.peerId, call_id: this.callId, signal: 'ice', ice: e.candidate });
        }
      };
      this.pc.onconnectionstatechange = () => {
        const s = this.pc.connectionState;
        if (s === 'connected') $('callState').textContent = T('call.p2p');
        if (s === 'failed' || s === 'disconnected') $('callState').textContent = T('call.connectionProblem');
      };
    },

    toggleMute() {
      if (!this.localStream) return;
      this.muted = !this.muted;
      this.localStream.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
      $('callMute').textContent = this.muted ? '🔇' : '🎙';
    },

    async toggleVideo() {
      if (!this.localStream || !this.pc) return;
      if (!this.videoOn) {
        try {
          const v = await navigator.mediaDevices.getUserMedia({ video: true });
          const track = v.getVideoTracks()[0];
          this.localStream.addTrack(track);
          const sender = this.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (sender) await sender.replaceTrack(track); else this.pc.addTrack(track, this.localStream);
          $('callLocal').srcObject = this.localStream;
          this.videoOn = true;
        } catch (e) { toast(T('call.noCamera'), 'err'); }
      } else {
        this.localStream.getVideoTracks().forEach((t) => { t.enabled = !t.enabled; });
        this.videoOn = false;
      }
      $('callVideoToggle').textContent = this.videoOn ? '🎥' : '🚫';
    },

    async toggleScreen() {
      if (!this.pc) return toast(T('call.needChat'), 'err');
      try {
        if (this.screenStream) {
          this.screenStream.getTracks().forEach((t) => t.stop());
          this.screenStream = null;
          if (this.localStream) {
            const cam = this.localStream.getVideoTracks()[0] || null;
            const sender = this.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
            if (sender) await sender.replaceTrack(cam);
          }
          toast(T('call.screenStopped'));
          return;
        }
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const track = this.screenStream.getVideoTracks()[0];
        const sender = this.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) await sender.replaceTrack(track); else this.pc.addTrack(track, this.screenStream);
        track.onended = () => this.toggleScreen();
        toast(T('call.screenStarted'), 'ok');
      } catch (e) { toast(T('call.screenCancelled'), 'err'); }
    },

    /* Крестик или красная трубка: отклоняем входящий либо завершаем разговор */
    hangup() {
      const App = global.App;
      if (this.waiting && !this.mediaReady) return this.decline();
      App.api.sendRaw({ t: 'call.signal', to: this.peerId, call_id: this.callId, signal: 'hangup' });
      if (App.user && this.chatId) {
        try { App.api.patch('/api/v1/calls/' + this.callId, { state: 'ended' }).catch(() => {}); } catch (e) {}
      }
      this.cleanup();
    },

    cleanup() {
      try { this.pc && this.pc.close(); } catch (e) {}
      this.pc = null;
      [this.localStream, this.screenStream].forEach((s) => { if (s) s.getTracks().forEach((t) => t.stop()); });
      this.localStream = null;
      this.screenStream = null;
      $('callRemote').srcObject = null;
      $('callLocal').srcObject = null;
      $('callOverlay').classList.add('hidden');
      $('callIncomingActions').classList.add('hidden');
      $('callControls').classList.remove('hidden');
      this.active = false;
      this.waiting = false;
      this.mediaReady = false;
      this.callId = null;
    },

    bindUI() {
      $('callAccept').onclick = () => this.accept();
      $('callDecline').onclick = () => this.decline();
      $('callClose').onclick = () => this.hangup();
      $('callHangup').onclick = () => this.hangup();
      $('callMute').onclick = () => this.toggleMute();
      $('callVideoToggle').onclick = () => this.toggleVideo();
      $('callScreen').onclick = () => this.toggleScreen();
    },
  };

  global.Call = Call;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Call.bindUI());
    else Call.bindUI();
  }
})(typeof window !== 'undefined' ? window : self);
