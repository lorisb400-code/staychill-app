import 'leaflet/dist/leaflet.css'
import './style.css'
import L from 'leaflet'
import { Geolocation } from '@capacitor/geolocation'
import { api, configured } from './api.js'
import { EMOJI, emojiHTML } from './emoji.js'

const ROME = [41.9028, 12.4964]
const TABS = {
  general: { title: 'General map', icon: '🗺️' },
  mine: { title: 'My map', icon: '📍' },
  spot: { title: 'Spot', icon: '📸' },
}

const state = {
  user: null,
  username: '',
  tab: 'general',
  places: [],
  myVotes: {},
  marks: [],
  spots: [],
  placing: false,
}

const app = document.getElementById('app')
let map, layer, meMarker

// ---------------------------------------------------------------- utilità
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const $ = (sel, root = document) => root.querySelector(sel)
const fmtDate = (iso) => new Date(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })

function toast(msg, isError = false) {
  const t = $('#toast')
  if (!t) return alert(msg)
  t.textContent = msg
  t.className = 'toast show' + (isError ? ' error' : '')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => (t.className = 'toast'), 3200)
}

async function busy(btn, fn) {
  if (btn) { btn.disabled = true; btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span>' }
  try { return await fn() } catch (e) { toast(e.message || 'Qualcosa è andato storto', true) } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = btn.dataset.label }
  }
}

function distanceM(a, b) {
  const R = 6371000, toR = (d) => (d * Math.PI) / 180
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function directionsLink(lat, lng) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
}

// Ridimensiona e ricomprime la foto: così pesa poco e perde i metadati (GPS, data, telefono)
async function compressImage(file, max = 1600) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height)
  bmp.close?.()
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Foto non leggibile'))), 'image/jpeg', 0.82))
}

// ---------------------------------------------------------------- login
function renderLogin(mode = 'login') {
  app.innerHTML = `
  <div class="auth">
    <div class="auth-brand">
      <div class="logo">${emojiHTML(4, 56)}</div>
      <h1>StayChill</h1>
      <p>La mappa dei posti, valutata da chi ci è stato.</p>
    </div>
    <form class="auth-card" id="authForm" novalidate>
      <div class="seg">
        <button type="button" data-mode="login" class="${mode === 'login' ? 'on' : ''}">Accedi</button>
        <button type="button" data-mode="signup" class="${mode === 'signup' ? 'on' : ''}">Registrati</button>
      </div>
      ${mode === 'signup' ? '<label>Nome utente<input name="username" autocomplete="username" maxlength="20" placeholder="come ti vedono gli altri" required></label>' : ''}
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label>Password<input name="password" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" minlength="6" required></label>
      <button class="btn primary" type="submit">${mode === 'signup' ? 'Crea account' : 'Entra'}</button>
      ${!configured ? '<p class="hint">Modalità demo: i dati non vengono salvati.</p>' : ''}
    </form>
    <div id="toast" class="toast"></div>
  </div>`
  app.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => renderLogin(b.dataset.mode)))
  $('#authForm').onsubmit = (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    const email = String(f.get('email') || '').trim()
    const password = String(f.get('password') || '')
    const username = String(f.get('username') || '').trim()
    if (!email || password.length < 6) return toast('Inserisci email e una password di almeno 6 caratteri.', true)
    if (mode === 'signup' && username.length < 3) return toast('Il nome utente deve avere almeno 3 caratteri.', true)
    busy(e.target.querySelector('button[type=submit]'), async () => {
      if (mode === 'signup') {
        const { needsConfirm } = await api.signUp(email, password, username)
        if (needsConfirm) toast('Ti abbiamo mandato una email: conferma e poi accedi.')
      } else {
        await api.signIn(email, password)
      }
    })
  }
}

// ---------------------------------------------------------------- shell
function renderShell() {
  app.innerHTML = `
  <header class="top">
    <div class="brand">${emojiHTML(4, 22)}<span>StayChill</span></div>
    <div class="tab-title" id="tabTitle"></div>
    <button class="icon-btn" id="accountBtn" aria-label="Account">👤</button>
  </header>
  <main class="stage">
    <div id="map"></div>
    <div class="crosshair" id="crosshair" hidden><div></div></div>
    <div class="place-bar" id="placeBar" hidden>
      <span>Sposta la mappa sul punto</span>
      <button class="btn ghost" id="placeCancel">Annulla</button>
      <button class="btn primary" id="placeOk">Qui</button>
    </div>
    <div class="map-tools">
      <button class="icon-btn round" id="legendBtn" aria-label="Legenda">?</button>
      <button class="icon-btn round" id="refreshBtn" aria-label="Aggiorna">⟳</button>
      <button class="icon-btn round" id="locateBtn" aria-label="La mia posizione">◎</button>
    </div>
    <button class="fab" id="fab" aria-label="Aggiungi">+</button>
  </main>
  <nav class="tabs">
    ${Object.entries(TABS).map(([k, t]) => `<button data-tab="${k}"><span class="ti">${t.icon}</span><span>${t.title}</span></button>`).join('')}
  </nav>
  <div class="backdrop" id="backdrop"></div>
  <section class="sheet" id="sheet" aria-live="polite"><div class="grip"></div><div id="sheetBody"></div></section>
  <div id="toast" class="toast"></div>`

  map = L.map('map', { zoomControl: false, attributionControl: true }).setView(ROME, 13)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map)
  layer = L.layerGroup().addTo(map)

  app.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)))
  $('#fab').onclick = startPlacing
  $('#placeCancel').onclick = stopPlacing
  $('#placeOk').onclick = confirmPlacing
  $('#locateBtn').onclick = () => locate(true)
  $('#refreshBtn').onclick = (e) => busy(e.currentTarget, () => loadTab(true))
  $('#legendBtn').onclick = showLegend
  $('#accountBtn').onclick = showAccount
  $('#backdrop').onclick = closeSheet
  enableSheetDrag()

  switchTab('general')
  locate(false)
}

function switchTab(tab) {
  state.tab = tab
  stopPlacing()
  closeSheet()
  app.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab))
  $('#tabTitle').textContent = TABS[tab].title
  $('#fab').className = 'fab fab-' + tab
  loadTab()
}

async function loadTab(force = false) {
  const tab = state.tab
  try {
    if (tab === 'general') {
      const [places, votes] = await Promise.all([api.listPlaces(), api.myVotes(state.user.id)])
      state.places = places; state.myVotes = votes
    } else if (tab === 'mine') {
      state.marks = await api.listMarks()
    } else {
      state.spots = await api.listSpots()
    }
    if (state.tab === tab) drawMarkers()
    if (force) toast('Aggiornato')
  } catch (e) {
    toast(e.message, true)
  }
}

// ---------------------------------------------------------------- marker
function pin(inner, cls = '', badge = '') {
  return L.divIcon({
    className: 'pin-wrap',
    html: `<div class="pin ${cls}">${inner}${badge ? `<b class="badge">${badge}</b>` : ''}</div>`,
    iconSize: [44, 52],
    iconAnchor: [22, 50],
  })
}

function drawMarkers() {
  layer.clearLayers()
  if (state.tab === 'general') {
    for (const p of state.places) {
      const inner = p.winner ? emojiHTML(p.winner, 26) : '<span class="q">?</span>'
      const cls = p.winner ? `w${p.winner}` : 'empty'
      L.marker([p.lat, p.lng], { icon: pin(inner, cls, p.total > 1 ? p.total : '') })
        .on('click', () => openPlace(p.id))
        .addTo(layer)
    }
  } else if (state.tab === 'mine') {
    for (const m of state.marks) {
      L.marker([m.lat, m.lng], { icon: pin(emojiHTML(m.emoji, 26), `w${m.emoji} mine`) })
        .on('click', () => openMark(m.id))
        .addTo(layer)
    }
  } else {
    for (const s of state.spots) {
      const icon = L.divIcon({
        className: 'pin-wrap',
        html: `<div class="photo-pin"><img src="${esc(api.photoUrl(s.photo_path))}" alt="" loading="lazy"></div>`,
        iconSize: [52, 60],
        iconAnchor: [26, 58],
      })
      L.marker([s.lat, s.lng], { icon }).on('click', () => openSpot(s.id)).addTo(layer)
    }
  }
}

// ---------------------------------------------------------------- posizione
async function locate(fly) {
  try {
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 })
    const ll = [pos.coords.latitude, pos.coords.longitude]
    if (!meMarker) {
      meMarker = L.marker(ll, { icon: L.divIcon({ className: 'pin-wrap', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 1000 }).addTo(map)
    } else meMarker.setLatLng(ll)
    map.flyTo(ll, Math.max(map.getZoom(), 15), { duration: fly ? 0.8 : 0 })
  } catch {
    if (fly) toast('Non riesco a trovare la tua posizione. Controlla che il GPS sia attivo e che l\'app abbia il permesso.', true)
  }
}

// ---------------------------------------------------------------- aggiunta punto
function startPlacing() {
  closeSheet()
  state.placing = true
  $('#crosshair').hidden = false
  $('#placeBar').hidden = false
  $('#fab').hidden = true
}
function stopPlacing() {
  state.placing = false
  const c = $('#crosshair'); if (c) c.hidden = true
  const b = $('#placeBar'); if (b) b.hidden = true
  const f = $('#fab'); if (f) f.hidden = false
}
function confirmPlacing() {
  const c = map.getCenter()
  stopPlacing()
  const at = { lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6) }
  if (state.tab === 'general') newPlaceForm(at)
  else if (state.tab === 'mine') newMarkForm(at)
  else newSpotForm(at)
}

function emojiPicker(selected) {
  return `<div class="picker">${[1, 2, 3, 4].map((n) => `
    <button type="button" class="pick w${n} ${selected === n ? 'on' : ''}" data-emoji="${n}">
      ${emojiHTML(n, 34)}<span>${EMOJI[n].label}</span>
    </button>`).join('')}</div>`
}

// ---------------------------------------------------------------- sheet
function openSheet(html) {
  $('#sheetBody').innerHTML = html
  const s = $('#sheet')
  s.style.transform = ''
  s.classList.add('open')
  $('#backdrop').classList.add('show')
  return $('#sheetBody')
}
function closeSheet() {
  $('#sheet')?.classList.remove('open')
  $('#backdrop')?.classList.remove('show')
}
function enableSheetDrag() {
  const s = $('#sheet')
  let y0 = null, dy = 0
  s.addEventListener('touchstart', (e) => {
    if (s.scrollTop > 0 && !e.target.closest('.grip')) return
    y0 = e.touches[0].clientY; dy = 0
  }, { passive: true })
  s.addEventListener('touchmove', (e) => {
    if (y0 == null) return
    dy = Math.max(0, e.touches[0].clientY - y0)
    if (dy > 0) s.style.transform = `translateY(${dy}px)`
  }, { passive: true })
  s.addEventListener('touchend', () => {
    if (y0 == null) return
    s.style.transform = ''
    if (dy > 90) closeSheet()
    y0 = null
  })
}

// ---------------------------------------------------------------- 1. GENERAL MAP
function newPlaceForm(at) {
  const near = state.places
    .map((p) => ({ p, d: distanceM(at, p) }))
    .filter((x) => x.d < 60)
    .sort((a, b) => a.d - b.d)[0]

  const body = openSheet(`
    <h2>Nuovo luogo</h2>
    ${near ? `<div class="notice">C'è già <b>${esc(near.p.name)}</b> a ${Math.round(near.d)} m. Meglio votare quello, così i voti non si dividono.
      <button class="btn small" id="openNear">Apri ${esc(near.p.name)}</button></div>` : ''}
    <label>Nome del luogo<input id="pName" maxlength="60" placeholder="es. Panchina del laghetto"></label>
    <p class="label">Il tuo voto</p>
    ${emojiPicker(null)}
    <button class="btn primary wide" id="pSave">Aggiungi alla mappa</button>`)
  let chosen = null
  body.querySelectorAll('.pick').forEach((b) => (b.onclick = () => {
    chosen = +b.dataset.emoji
    body.querySelectorAll('.pick').forEach((x) => x.classList.toggle('on', x === b))
  }))
  if (near) $('#openNear').onclick = () => openPlace(near.p.id)
  $('#pSave').onclick = (e) => busy(e.currentTarget, async () => {
    const name = $('#pName').value.trim()
    if (!name) return toast('Dai un nome al luogo.', true)
    if (!chosen) return toast('Scegli un\'emoji.', true)
    const id = await api.addPlace(name, at.lat, at.lng)
    await api.setVote(id, state.user.id, chosen)
    closeSheet()
    await loadTab()
    toast('Luogo aggiunto')
  })
}

function openPlace(id) {
  const p = state.places.find((x) => x.id === id)
  if (!p) return
  map.panTo([p.lat, p.lng])
  const mine = state.myVotes[id] ?? null
  const max = Math.max(1, p.c1, p.c2, p.c3, p.c4)
  const body = openSheet(`
    <div class="place-head">
      <div class="big ${p.winner ? 'w' + p.winner : 'empty'}">${p.winner ? emojiHTML(p.winner, 46) : '<span class="q">?</span>'}</div>
      <div>
        <h2>${esc(p.name)}</h2>
        <p class="muted">${p.winner ? `<b>${EMOJI[p.winner].label}</b> · ` : ''}${p.total} ${p.total === 1 ? 'voto' : 'voti'}</p>
      </div>
    </div>
    <div class="bars">${[1, 2, 3, 4].map((n) => `
      <div class="bar-row">${emojiHTML(n, 22)}
        <div class="bar"><i style="width:${(p['c' + n] / max) * 100}%;background:${EMOJI[n].color}"></i></div>
        <b>${p['c' + n]}</b></div>`).join('')}
    </div>
    <p class="label">${mine ? 'Il tuo voto (tocca di nuovo per toglierlo)' : 'Vota questo luogo'}</p>
    ${emojiPicker(mine)}
    <div class="row">
      <a class="btn ghost" href="${directionsLink(p.lat, p.lng)}">Portami qui</a>
      ${p.created_by === state.user.id ? '<button class="btn danger" id="pDel">Elimina luogo</button>' : ''}
    </div>`)
  body.querySelectorAll('.pick').forEach((b) => (b.onclick = () => busy(null, async () => {
    const n = +b.dataset.emoji
    const next = mine === n ? null : n
    body.querySelectorAll('.pick').forEach((x) => (x.disabled = true))
    await api.setVote(id, state.user.id, next)
    await loadTab()
    openPlace(id)
  })))
  const del = $('#pDel')
  if (del) del.onclick = (e) => {
    if (p.total > 1 && !confirm(`Eliminare "${p.name}"? Si perderanno anche i ${p.total} voti degli altri.`)) return
    busy(e.currentTarget, async () => { await api.deletePlace(id); closeSheet(); await loadTab(); toast('Luogo eliminato') })
  }
}

// ---------------------------------------------------------------- 2. MY MAP
function newMarkForm(at) {
  const body = openSheet(`
    <h2>Segna questo posto</h2>
    <p class="muted">Lo vedi solo tu.</p>
    ${emojiPicker(null)}
    <label>Nota (facoltativa)<textarea id="mNote" maxlength="200" rows="2" placeholder="Solo per te"></textarea></label>
    <button class="btn primary wide" id="mSave">Salva</button>`)
  let chosen = null
  body.querySelectorAll('.pick').forEach((b) => (b.onclick = () => {
    chosen = +b.dataset.emoji
    body.querySelectorAll('.pick').forEach((x) => x.classList.toggle('on', x === b))
  }))
  $('#mSave').onclick = (e) => busy(e.currentTarget, async () => {
    if (!chosen) return toast('Scegli un\'emoji.', true)
    await api.addMark(at.lat, at.lng, chosen, $('#mNote').value.trim())
    closeSheet()
    await loadTab()
    toast('Salvato nella tua mappa')
  })
}

function openMark(id) {
  const m = state.marks.find((x) => x.id === id)
  if (!m) return
  map.panTo([m.lat, m.lng])
  openSheet(`
    <div class="place-head">
      <div class="big w${m.emoji}">${emojiHTML(m.emoji, 46)}</div>
      <div><h2>${EMOJI[m.emoji].label}</h2><p class="muted">Segnato il ${fmtDate(m.created_at)} · privato</p></div>
    </div>
    ${m.note ? `<p class="note">${esc(m.note)}</p>` : ''}
    <div class="row">
      <a class="btn ghost" href="${directionsLink(m.lat, m.lng)}">Portami qui</a>
      <button class="btn danger" id="mDel">Elimina</button>
    </div>`)
  $('#mDel').onclick = (e) => busy(e.currentTarget, async () => { await api.deleteMark(id); closeSheet(); await loadTab(); toast('Eliminato') })
}

// ---------------------------------------------------------------- 3. SPOT
function newSpotForm(at) {
  let blob = null
  const body = openSheet(`
    <h2>Nuovo spot</h2>
    <div class="photo-drop" id="sPreview"><span>Aggiungi una foto</span></div>
    <div class="row">
      <label class="btn ghost file">📷 Scatta<input type="file" accept="image/*" capture="environment" id="sCam"></label>
      <label class="btn ghost file">🖼️ Galleria<input type="file" accept="image/*" id="sGal"></label>
    </div>
    <label>Titolo<input id="sTitle" maxlength="60" placeholder="es. Panchina con vista"></label>
    <label>Descrizione (facoltativa)<textarea id="sDesc" maxlength="300" rows="2"></textarea></label>
    <p class="hint">La posizione e gli altri dati nascosti nella foto vengono rimossi prima di pubblicarla.</p>
    <button class="btn primary wide" id="sSave">Pubblica</button>`)
  const onFile = (e) => busy(null, async () => {
    const f = e.target.files?.[0]
    if (!f) return
    blob = await compressImage(f)
    $('#sPreview').innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="">`
  })
  $('#sCam').onchange = onFile
  $('#sGal').onchange = onFile
  $('#sSave').onclick = (e) => busy(e.currentTarget, async () => {
    const title = $('#sTitle').value.trim()
    if (!blob) return toast('Aggiungi una foto.', true)
    if (!title) return toast('Dai un titolo allo spot.', true)
    await api.addSpot({ userId: state.user.id, lat: at.lat, lng: at.lng, title, description: $('#sDesc').value.trim(), blob })
    closeSheet()
    await loadTab()
    toast('Spot pubblicato')
  })
}

function openSpot(id) {
  const s = state.spots.find((x) => x.id === id)
  if (!s) return
  map.panTo([s.lat, s.lng])
  const own = s.user_id === state.user.id
  openSheet(`
    <img class="spot-img" src="${esc(api.photoUrl(s.photo_path))}" alt="">
    <h2>${esc(s.title)}</h2>
    ${s.description ? `<p class="note">${esc(s.description)}</p>` : ''}
    <p class="muted">di <b>${esc(s.username || 'utente')}</b> · ${fmtDate(s.created_at)}${s.hidden ? ' · <b>nascosto per segnalazioni</b>' : ''}</p>
    <div class="row">
      <a class="btn ghost" href="${directionsLink(s.lat, s.lng)}">Portami qui</a>
      ${own ? '<button class="btn danger" id="sDel">Elimina</button>' : '<button class="btn ghost" id="sRep">Segnala</button>'}
    </div>`)
  const del = $('#sDel')
  if (del) del.onclick = (e) => busy(e.currentTarget, async () => { await api.deleteSpot(s); closeSheet(); await loadTab(); toast('Spot eliminato') })
  const rep = $('#sRep')
  if (rep) rep.onclick = (e) => {
    if (!confirm('Segnalare questa foto come inappropriata?')) return
    busy(e.currentTarget, async () => { await api.reportSpot(id); toast('Grazie, segnalazione inviata') })
  }
}

// ---------------------------------------------------------------- legenda e account
function showLegend() {
  openSheet(`
    <h2>Come funziona</h2>
    <div class="legend">${[1, 2, 3, 4].map((n) => `<div>${emojiHTML(n, 30)}<b>${EMOJI[n].label}</b></div>`).join('')}</div>
    <p class="muted"><b>General map</b>: ognuno vota i luoghi; sulla mappa compare l'emoji scelta più volte. A parità vince la più prudente.</p>
    <p class="muted"><b>My map</b>: i tuoi segni, visibili solo a te.</p>
    <p class="muted"><b>Spot</b>: foto di posti belli dove fermarsi, visibili a tutti.</p>
    <p class="muted">Tocca <b>+</b>, sposta la mappa sul punto e premi <b>Qui</b>.</p>`)
}

function showAccount() {
  openSheet(`
    <h2>${esc(state.username || 'Account')}</h2>
    <p class="muted">${esc(state.user.email || '')}</p>
    <button class="btn ghost wide" id="logout">Esci</button>`)
  $('#logout').onclick = () => { closeSheet(); api.signOut() }
}

// ---------------------------------------------------------------- avvio
async function onUser(user) {
  const changed = (user?.id ?? null) !== (state.user?.id ?? null)
  state.user = user
  if (!changed && $('#map')) return
  if (!user) { map?.remove(); map = null; meMarker = null; renderLogin(); return }
  const prof = await api.getProfile(user.id).catch(() => null)
  state.username = prof?.username || ''
  map?.remove(); meMarker = null
  renderShell()
}

;(async () => {
  api.onAuth((u) => onUser(u))
  const u = await api.getUser()
  if (u) onUser(u)
  else renderLogin()
})()
