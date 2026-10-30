import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_KEY } from './config.js'
import { winnerOf } from './emoji.js'

export const configured = Boolean(SUPABASE_URL && SUPABASE_KEY) && !(typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo'))
const BUCKET = 'spots'

function check({ data, error }) {
  if (error) throw new Error(translateError(error.message))
  return data
}

function translateError(msg = '') {
  const m = msg.toLowerCase()
  if (m.includes('invalid login credentials')) return 'Email o password sbagliate.'
  if (m.includes('already registered') || m.includes('already been registered')) return 'Questa email è già registrata. Prova ad accedere.'
  if (m.includes('password should be at least')) return 'La password deve avere almeno 6 caratteri.'
  if (m.includes('email not confirmed')) return 'Devi prima confermare l\'email (controlla la posta).'
  if (m.includes('rate limit')) return 'Troppi tentativi, riprova tra qualche minuto.'
  if (m.includes('failed to fetch') || m.includes('network')) return 'Connessione assente. Controlla internet e riprova.'
  return msg
}

function supabaseApi() {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })

  return {
    async getUser() {
      const { data } = await sb.auth.getSession()
      return data.session?.user ?? null
    },
    onAuth(cb) {
      sb.auth.onAuthStateChange((_e, session) => cb(session?.user ?? null))
    },
    async signUp(email, password, username) {
      const data = check(await sb.auth.signUp({ email, password, options: { data: { username } } }))
      return { needsConfirm: !data.session }
    },
    async signIn(email, password) {
      check(await sb.auth.signInWithPassword({ email, password }))
    },
    async signOut() {
      await sb.auth.signOut()
    },
    async getProfile(userId) {
      const { data } = await sb.from('profiles').select('username').eq('id', userId).maybeSingle()
      return data
    },

    // ---- General map
    async listPlaces() {
      return check(await sb.from('place_summary').select('*').limit(5000))
    },
    async myVotes(userId) {
      const rows = check(await sb.from('votes').select('place_id, emoji').eq('user_id', userId))
      return Object.fromEntries(rows.map((r) => [r.place_id, r.emoji]))
    },
    async addPlace(name, lat, lng) {
      return check(await sb.from('places').insert({ name, lat, lng }).select('id').single()).id
    },
    async deletePlace(id) {
      check(await sb.from('places').delete().eq('id', id))
    },
    async setVote(placeId, userId, emoji) {
      if (emoji == null) {
        check(await sb.from('votes').delete().eq('place_id', placeId).eq('user_id', userId))
      } else {
        check(await sb.from('votes').upsert({ place_id: placeId, user_id: userId, emoji, updated_at: new Date().toISOString() }))
      }
    },

    // ---- My map
    async listMarks() {
      return check(await sb.from('my_marks').select('*').order('created_at', { ascending: false }))
    },
    async addMark(lat, lng, emoji, note) {
      return check(await sb.from('my_marks').insert({ lat, lng, emoji, note: note || null }).select('*').single())
    },
    async deleteMark(id) {
      check(await sb.from('my_marks').delete().eq('id', id))
    },

    // ---- Spot
    async listSpots() {
      return check(await sb.from('spot_feed').select('*').order('created_at', { ascending: false }).limit(1000))
    },
    photoUrl(path) {
      return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
    },
    async addSpot({ userId, lat, lng, title, description, blob }) {
      const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
      check(await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' }))
      try {
        check(await sb.from('spots').insert({ lat, lng, title, description: description || null, photo_path: path }))
      } catch (e) {
        await sb.storage.from(BUCKET).remove([path])
        throw e
      }
    },
    async deleteSpot(spot) {
      check(await sb.from('spots').delete().eq('id', spot.id))
      await sb.storage.from(BUCKET).remove([spot.photo_path])
    },
    async reportSpot(id) {
      const { error } = await sb.from('reports').insert({ spot_id: id })
      if (error && !String(error.code).startsWith('23505')) throw new Error(translateError(error.message))
    },
  }
}

// ---------------------------------------------------------------------
// Versione finta (solo per provare l'interfaccia senza Supabase: ?demo)
// ---------------------------------------------------------------------
function mockApi() {
  const me = { id: 'me', email: 'demo@staychill.app' }
  let user = null
  let authCb = () => {}
  let seq = 100
  const places = [
    { id: 1, name: 'Parco degli Acquedotti', lat: 41.8537, lng: 12.5583, created_by: 'x' },
    { id: 2, name: 'Villa Pamphili', lat: 41.8858, lng: 12.4517, created_by: 'x' },
    { id: 3, name: 'Gianicolo', lat: 41.8915, lng: 12.4612, created_by: 'me' },
  ]
  const votes = [
    { place_id: 1, user_id: 'a', emoji: 4 }, { place_id: 1, user_id: 'b', emoji: 4 }, { place_id: 1, user_id: 'c', emoji: 3 },
    { place_id: 2, user_id: 'a', emoji: 1 }, { place_id: 2, user_id: 'b', emoji: 4 },
    { place_id: 3, user_id: 'a', emoji: 2 },
  ]
  const marks = [{ id: 1, user_id: 'me', lat: 41.9009, lng: 12.4833, emoji: 3, note: 'Prova', created_at: new Date().toISOString() }]
  const spots = [
    { id: 1, user_id: 'a', username: 'marco', lat: 41.8892, lng: 12.4707, title: 'Tramonto sul Tevere', description: 'Panchina tranquilla con vista.', photo_path: 'demo', created_at: new Date().toISOString() },
  ]
  const demoPhoto = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f59e5b"/><stop offset="1" stop-color="#5b3a8a"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/><circle cx="200" cy="190" r="50" fill="#ffd27a"/><rect y="210" width="400" height="90" fill="#2a3f5a"/></svg>')
  const wait = (v) => new Promise((r) => setTimeout(() => r(v), 150))
  const summary = (p) => {
    const vs = votes.filter((v) => v.place_id === p.id)
    const c = { 1: 0, 2: 0, 3: 0, 4: 0 }
    vs.forEach((v) => c[v.emoji]++)
    return { ...p, c1: c[1], c2: c[2], c3: c[3], c4: c[4], total: vs.length, winner: winnerOf(c) }
  }
  return {
    demo: true,
    async getUser() { return user },
    onAuth(cb) { authCb = cb },
    async signUp() { user = me; authCb(user); return { needsConfirm: false } },
    async signIn() { user = me; authCb(user) },
    async signOut() { user = null; authCb(null) },
    async getProfile() { return { username: 'demo' } },
    async listPlaces() { return wait(places.map(summary)) },
    async myVotes() { return wait(Object.fromEntries(votes.filter((v) => v.user_id === 'me').map((v) => [v.place_id, v.emoji]))) },
    async addPlace(name, lat, lng) { const id = ++seq; places.push({ id, name, lat, lng, created_by: 'me' }); return wait(id) },
    async deletePlace(id) { places.splice(places.findIndex((p) => p.id === id), 1) },
    async setVote(placeId, _u, emoji) {
      const i = votes.findIndex((v) => v.place_id === placeId && v.user_id === 'me')
      if (i >= 0) votes.splice(i, 1)
      if (emoji != null) votes.push({ place_id: placeId, user_id: 'me', emoji })
      return wait()
    },
    async listMarks() { return wait([...marks]) },
    async addMark(lat, lng, emoji, note) { const m = { id: ++seq, user_id: 'me', lat, lng, emoji, note, created_at: new Date().toISOString() }; marks.unshift(m); return wait(m) },
    async deleteMark(id) { marks.splice(marks.findIndex((m) => m.id === id), 1) },
    async listSpots() { return wait([...spots]) },
    photoUrl(path) { return path.startsWith('blob:') ? path : demoPhoto },
    async addSpot({ lat, lng, title, description, blob }) {
      spots.unshift({ id: ++seq, user_id: 'me', username: 'demo', lat, lng, title, description, photo_path: URL.createObjectURL(blob), created_at: new Date().toISOString() })
      return wait()
    },
    async deleteSpot(spot) { spots.splice(spots.findIndex((s) => s.id === spot.id), 1) },
    async reportSpot() { return wait() },
  }
}

const demo = typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo')
export const api = configured && !demo ? supabaseApi() : mockApi()
