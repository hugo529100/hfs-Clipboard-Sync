'use strict'
exports.version = 1.9
exports.description = "Cross-device clipboard sync for HFS 3. Share cut/paste between browsers and devices logged into the same account. Server-side paste claiming prevents duplicates; pages on affected addresses update lists in place. Guests are rejected."
exports.apiRequired = 12.0
exports.repo = "hugo529100/hfs-Clipboard-Sync"
exports.frontend_js = "main.js"

exports.config = {
    onlyFor: {
        type: 'username',
        multiple: true,
        frontend: true,
        label: "Only for accounts",
        helperText: "Leave empty to allow every logged-in account. Guests are never synced.",
    },
    showToasts: {
        type: 'boolean',
        defaultValue: true,
        frontend: true,
        label: "Show toast notifications",
        helperText: "Turn off to suppress this plugin's toast messages (sync received, paste results, warnings). Error dialogs are unaffected.",
    },
    syncList: {
        type: 'boolean',
        defaultValue: true,
        frontend: true,
        label: "Refresh list for affected addresses",
        helperText: "When the account has 2+ visible pages, a change refreshes only pages sitting on the exact affected address. Move/copy/paste refresh both source and destination ends; unrelated addresses never refresh. A single-page account never enables this traffic. Clipboard sync is independent.",
    },
    debug: {
        type: 'boolean',
        defaultValue: false,
        frontend: true,
        label: "Debug logging",
    },
}

exports.init = async api => {
    const crypto = api.require('crypto')
    const { getCurrentUsername } = api.require('./auth')
    const { moveFiles } = api.require('./frontEndApis')

    const db = await api.openDb('clipboard', { rewriteLater: true })

    const CHANNEL_PREFIX = 'clipSync_'
    
    
    const CLIENT_AT_TOLERANCE = 2000
    const PRESENCE_TTL_MS = 90_000
    const QUEUE_GAP_MS = 50
    const PASTE_LEASE_MS = 30 * 60_000
    const MAX_ITEMS = 500
    const RECENT_MAX = 200

     
    const cache = new Map()
    
    
    const activeClaims = new Set()

    
    
    
    const presence = new Map()

    
    
    let queueHead = 0

    function log(...args) {
        if (api.getConfig('debug'))
            api.log('[Clipboard-Sync]', ...args)
    }

    function text(value, maxLen) {
        return typeof value === 'string' ? value.slice(0, maxLen) : ''
    }

    function safeDecode(value) {
        try { return decodeURI(String(value)) }
        catch { return String(value) }
    }

    function normalizeDir(uri) {
        let p = safeDecode(uri)
        if (!p.startsWith('/')) p = '/' + p
        if (!p.endsWith('/')) p += '/'
        return p
    }

    function dirnameOf(uri) {
        let p = normalizeDir(uri)
        p = p.replace(/\/+$/, '')
        if (!p) return '/'
        const i = p.lastIndexOf('/')
        return i <= 0 ? '/' : p.slice(0, i + 1)
    }

    function cleanClient(value) {
        const id = text(value?.id, 80).replace(/[\s\r\n\t]/g, '')
        const label = text(value?.label, 60).replace(/[\r\n\t]/g, ' ').trim()
        return { id: id || 'unknown', label: label || 'unknown' }
    }

    function cleanItems(value) {
        if (!Array.isArray(value)) return []
        const out = []
        const seen = new Set()
        for (const raw of value) {
            if (!raw || typeof raw !== 'object') continue
            const uri = typeof raw.uri === 'string' ? raw.uri.trim() : ''
            if (!uri.startsWith('/') || uri.length > 3000 || uri.includes('\0')) continue
            if (seen.has(uri)) continue
            seen.add(uri)
            const fallbackName = uri.split('/').filter(Boolean).pop() || uri
            const name = (typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : fallbackName).slice(0, 260)
            out.push({ uri, name, isFolder: Boolean(raw.isFolder) || uri.endsWith('/') })
            if (out.length >= MAX_ITEMS) break
        }
        return out
    }

    function blankState() {
        return { username: null, version: 0, at: 0, kind: null, items: [], owner: null, recent: [], pasting: null }
    }

    function normalizeRecord(raw) {
        const state = blankState()
        if (!raw || typeof raw !== 'object') return state
        if (Number.isFinite(raw.version)) state.version = Math.max(0, Math.floor(raw.version))
        if (Number.isFinite(raw.at)) state.at = Math.max(0, Math.floor(raw.at))
        if (raw.kind === 'cut') {
            const items = cleanItems(raw.items)
            if (items.length) {
                state.kind = 'cut'
                state.items = items
                if (raw.owner) state.owner = cleanClient(raw.owner)
            }
        }
        if (Array.isArray(raw.recent))
            state.recent = raw.recent.filter(x => typeof x === 'string' && x.length <= 120).slice(0, RECENT_MAX)
        return state
    }

    async function load(username) {
        const cached = cache.get(username)
        if (cached) return cached
        let raw
        try { raw = await db.get(username) }
        catch (e) { log('db.get failed', e) }
        const state = normalizeRecord(raw)
        state.username = username
        cache.set(username, state)
        return state
    }

    function persist(username, state) {
        const record = {
            version: state.version,
            at: state.at,
            kind: state.kind,
            items: state.items,
            owner: state.owner,
            recent: state.recent,
        }
        try {
            const result = db.put(username, record)
            if (result && typeof result.catch === 'function')
                result.catch(e => log('db.put failed', e))
        }
        catch (e) { log('db.put failed', e) }
    }

    function publicState(state) {
        return {
            account: state.username,
            version: state.version,
            at: state.at,
            atISO: state.at ? new Date(state.at).toISOString() : null,
            kind: state.kind,
            items: state.items,
            owner: state.owner,
            pasting: state.pasting
                ? { id: state.pasting.id, label: state.pasting.label, at: state.pasting.at }
                : null,
            lastOp: state.recent[0] || null,
        }
    }

    function expirePasting(state) {
        if (!state.pasting) return false
        if (activeClaims.has(state.pasting.opId)) return false
        if (Date.now() - state.pasting.at <= PASTE_LEASE_MS) return false
        state.pasting = null
        return true
    }

    function touch(state) {
        state.version++
        
        
        const now = Date.now()
        const at = Math.max(
            state.at + 1,
            Math.min(Math.max(now, queueHead + QUEUE_GAP_MS), now + 1000),
        )
        state.at = at
        queueHead = at
    }

    function remember(state, opId) {
        state.recent.unshift(opId)
        if (state.recent.length > RECENT_MAX) state.recent.length = RECENT_MAX
    }

    function channelFor(username) {
        return CHANNEL_PREFIX + Buffer.from(username, 'utf8').toString('base64url')
    }

    function isAllowed(username) {
        if (!username) return false
        const configured = api.getConfig('onlyFor')
        const only = Array.isArray(configured) ? configured : configured ? [configured] : []
        return !only.length || only.includes(username)
    }

    function requireUser(ctx) {
        const username = getCurrentUsername(ctx)
        return isAllowed(username) ? username : null
    }

    function broadcast(username, state) {
        try { api.notifyClient(channelFor(username), 'state', publicState(state)) }
        catch (e) { log('notifyClient failed', e) }
    }

    function syncListEnabled() {
        return api.getConfig('syncList') !== false
    }

    function prunePresence(map, now = Date.now()) {
        const ttl = PRESENCE_TTL_MS
        for (const [sessionId, session] of map)
            if (now - session.at > ttl) map.delete(sessionId)
        return map
    }

    function presenceFor(username) {
        let map = presence.get(username)
        if (!map) {
            map = new Map()
            presence.set(username, map)
        }
        return prunePresence(map)
    }

     
    function presenceCounts(username, path) {
        const map = presence.get(username)
        if (!map) return { total: 0, atPath: 0 }
        prunePresence(map)
        let total = 0
        let atPath = 0
        for (const session of map.values()) {
            if (!session.visible) continue
            total++
            if (session.path === path) atPath++
        }
        return { total, atPath }
    }

     












    function refreshPath(username, path, info) {
        if (!username || !syncListEnabled()) return false
        const dir = normalizeDir(path || '/')
        const { total, atPath } = presenceCounts(username, dir)
        if (total < 2 || atPath < 1) {
            log('no refresh (pages=' + total + ', here=' + atPath + ')', username, dir)
            return false
        }
        try {
            api.notifyClient(channelFor(username), 'refresh', {
                path: dir,
                at: Date.now(),
                source: info?.source || '',
                reason: info?.reason || 'change',
                patch: info?.patch || undefined,
            })
            log('refresh', username, dir, info?.reason, 'pages=' + total + ', here=' + atPath)
        }
        catch (e) { log('notify refresh failed', e) }
        return true
    }

     




    function refreshTargets(username, targets, info) {
        const done = new Set()
        for (const target of targets) {
            const path = typeof target === 'string' ? target : target?.path
            const dir = normalizeDir(path || '/')
            if (done.has(dir)) continue
            done.add(dir)
            refreshPath(username, dir, {
                ...info,
                patch: typeof target === 'string' ? undefined : target.patch,
            })
        }
    }

    function uriName(uri) {
        return safeDecode(uri).replace(/\/+$/, '').split('/').pop() || ''
    }

    function listTarget(path, patch) {
        return { path, patch }
    }

     





    function detectListChange(ctx) {
        if (!syncListEnabled()) return
        const path = typeof ctx.path === 'string' ? ctx.path : ''
        if (!path) return
        const SPECIAL_URI = api.Const.SPECIAL_URI
        const API_URI = api.Const.API_URI

        
        if (ctx.method === 'DELETE' && !path.startsWith(SPECIAL_URI))
            return { reason: 'delete', targets: [listTarget(dirnameOf(path), { removed: [path] })] }

        
        if (ctx.method === 'PUT' && !path.startsWith(SPECIAL_URI))
            return {
                reason: 'upload',
                targets: [listTarget(dirnameOf(path), { added: [{ name: uriName(path) }] })],
                requireUploadPath: true,
            }
        if (ctx.method === 'POST' && path.endsWith('/') && !path.startsWith(SPECIAL_URI) && !path.startsWith(API_URI))
            return { reason: 'upload', targets: [listTarget(normalizeDir(path))], requireUploads: true }

        if (!path.startsWith(API_URI)) return
        const name = path.slice(API_URI.length)
        const params = ctx.state?.params || {}
        const stringUri = value => typeof value === 'string' && value.startsWith('/') ? value : ''
        switch (name) {
            case 'comment': {
                const uri = stringUri(params.uri)
                if (!uri) return
                const text = typeof params.comment === 'string' ? params.comment : ''
                const targets = [listTarget(dirnameOf(uri), { comment: { uri, text } })]
                if (uri.endsWith('/')) targets.push(listTarget(uri, { folderComment: text }))
                return { reason: 'comment', targets }
            }
            case 'rename': {
                const uri = stringUri(params.uri)
                const newName = typeof params.dest === 'string' ? params.dest : ''
                if (!uri || !newName) return
                return { reason: 'rename', targets: [listTarget(dirnameOf(uri), { renamed: { from: uri, name: newName } })] }
            }
            case 'create_folder': {
                const parent = stringUri(params.uri)
                const folderName = typeof params.name === 'string' ? params.name : ''
                if (!parent || !folderName) return
                return { reason: 'create', targets: [listTarget(parent, { added: [{ name: folderName, isFolder: true }] })] }
            }
            case 'move_files':
            case 'copy_files': {
                const from = Array.isArray(params.uri_from)
                    ? params.uri_from.filter(value => typeof value === 'string' && value.startsWith('/'))
                    : []
                const to = stringUri(params.uri_to)
                const targets = []
                if (name === 'move_files') {
                    const byDir = new Map()
                    for (const uri of from) {
                        const dir = dirnameOf(uri)
                        const list = byDir.get(dir) || []
                        list.push(uri)
                        byDir.set(dir, list)
                    }
                    for (const [dir, uris] of byDir)
                        targets.push(listTarget(dir, { removed: uris }))
                }
                if (to && from.length)
                    targets.push(listTarget(to, {
                        added: from.map(uri => ({ name: uriName(uri), isFolder: uri.endsWith('/') })),
                    }))
                return targets.length && { reason: name, targets }
            }
        }
    }

    const customRest = {
         
        async clipSync_state(_params, ctx) {
            const username = requireUser(ctx)
            if (!username) return { ok: false, reason: 'auth' }
            const state = await load(username)
            const expired = expirePasting(state)
            if (expired) persist(username, state)
            return {
                ok: true,
                channel: channelFor(username),
                serverNow: Date.now(),
                snapshot: publicState(state),
            }
        },

         
        async clipSync_ping(params, ctx) {
            const username = requireUser(ctx)
            if (!username) return { ok: false, reason: 'auth' }
            if (!syncListEnabled()) return { ok: false, reason: 'disabled' }

            const sessionId = text(params?.sessionId, 100)
            if (!sessionId) return { ok: false, reason: 'bad' }
            const path = normalizeDir(text(params?.path, 3000) || '/')
            const visible = params?.visible !== false
            const map = presenceFor(username)
            map.set(sessionId, {
                path,
                at: Date.now(),
                visible,
                label: cleanClient(params.client).label,
            })
            let peers = 0
            for (const session of map.values())
                if (session.visible && session.path === path) peers++
            return {
                ok: true,
                path,
                peers,
                active: peers >= 2,
                serverNow: Date.now(),
            }
        },

         
        async clipSync_publish(params, ctx) {
            const username = requireUser(ctx)
            if (!username) return { ok: false, reason: 'auth' }

            const opId = text(params?.opId, 120)
            if (!opId) return { ok: false, reason: 'bad' }

            const state = await load(username)
            
            if (state.recent.includes(opId))
                return { ok: true, duplicate: true, snapshot: publicState(state) }

            expirePasting(state)

            let kind = params?.kind === 'clear' ? 'clear'
                : params?.kind === 'cut' ? 'cut'
                    : null
            if (!kind) return { ok: false, reason: 'bad' }

            
            if (state.pasting)
                return { ok: false, reason: 'busy', snapshot: publicState(state) }

            if (kind === 'cut') {
                const items = cleanItems(params.items)
                if (!items.length) kind = 'clear'
                else {
                    const clientAt = Number(params.clientAt)
                    
                    if (Number.isFinite(clientAt) && clientAt < state.at - CLIENT_AT_TOLERANCE)
                        return { ok: false, reason: 'stale', snapshot: publicState(state) }
                    state.kind = 'cut'
                    state.items = items
                    state.owner = cleanClient(params.client)
                }
            }

            if (kind === 'clear') {
                const baseVersion = Number(params.baseVersion)
                if (Number.isFinite(baseVersion) && baseVersion !== state.version)
                    return { ok: false, reason: 'stale', snapshot: publicState(state) }
                state.kind = null
                state.items = []
                state.owner = null
            }

            touch(state)
            remember(state, opId)
            persist(username, state)
            broadcast(username, state)
            log('publish', username, kind, 'v' + state.version)
            return { ok: true, snapshot: publicState(state) }
        },

         



        async clipSync_paste(params, ctx) {
            const username = requireUser(ctx)
            if (!username) return { ok: false, reason: 'auth' }

            const opId = text(params?.opId, 120)
            const to = text(params?.to, 3000)
            const source = text(params?.source, 100)
            if (!opId || !to || !to.startsWith('/')) return { ok: false, reason: 'bad' }

            const state = await load(username)
            if (state.recent.includes(opId))
                return { ok: true, duplicate: true, snapshot: publicState(state) }

            expirePasting(state)

            if (state.kind !== 'cut' || !state.items.length)
                return { ok: false, reason: 'empty', snapshot: publicState(state) }

            const version = Number(params.version)
            if (Number.isFinite(version) && version !== state.version)
                return { ok: false, reason: 'stale', snapshot: publicState(state) }

            if (state.pasting)
                return { ok: false, reason: 'busy', snapshot: publicState(state) }

            const target = normalizeDir(to)
            if (state.items.every(item => dirnameOf(item.uri) === target))
                return { ok: false, reason: 'same', snapshot: publicState(state) }

            const client = cleanClient(params.client)
            const claimed = state.items.slice()
            state.pasting = { id: client.id, label: client.label, at: Date.now(), opId }
            persist(username, state)
            broadcast(username, state)

            activeClaims.add(opId)
            let result
            try {
                result = await moveFiles(claimed.map(item => item.uri), to, ctx)
            }
            catch (e) {
                log('moveFiles threw', e)
                result = { errors: claimed.map(() => e?.code || e?.message || 'error') }
            }
            finally {
                activeClaims.delete(opId)
            }

            
            if (!state.pasting || state.pasting.opId !== opId)
                return { ok: false, reason: 'superseded', snapshot: publicState(state) }

            let errors = Array.isArray(result?.errors) ? result.errors : null
            if (!errors) {
                const failure = result?.code || result?.message || 'error'
                errors = claimed.map(() => failure)
            }

            const remaining = claimed.filter((_item, i) => errors[i])
            const moved = claimed.length - remaining.length

            state.pasting = null
            state.items = remaining
            state.kind = remaining.length ? 'cut' : null
            state.owner = remaining.length ? client : null
            touch(state)
            remember(state, opId)
            persist(username, state)
            broadcast(username, state)
            log('paste', username, 'moved', moved, 'remaining', remaining.length, 'v' + state.version)

            
            const movedItems = claimed.filter((_item, i) => !errors[i])
            const targets = []
            const byDir = new Map()
            for (const item of movedItems) {
                const dir = dirnameOf(item.uri)
                const list = byDir.get(dir) || []
                list.push(item.uri)
                byDir.set(dir, list)
            }
            for (const [dir, uris] of byDir)
                targets.push(listTarget(dir, { removed: uris }))
            if (movedItems.length)
                targets.push(listTarget(to, {
                    added: movedItems.map(item => ({ name: item.name, isFolder: Boolean(item.isFolder) })),
                }))
            if (targets.length)
                refreshTargets(username, targets, { source, reason: 'paste' })

            return { ok: true, moved, errors, snapshot: publicState(state) }
        },
    }

    
    
    
    async function middleware(ctx) {
        
        
        const API_URI = api.Const.API_URI
        if (typeof ctx.path === 'string' && ctx.path.startsWith(API_URI + '_clipSync_')) {
            if (!getCurrentUsername(ctx)) {
                ctx.status = 401
                ctx.type = 'text/plain; charset=utf-8'
                ctx.body = 'login required'
                return ctx.stop()
            }
        }

        const channel = ctx.query?.channel
        if (typeof channel === 'string' && channel.startsWith(CHANNEL_PREFIX)
            && ctx.path.endsWith('/get_notifications')) {
            const username = getCurrentUsername(ctx)
            if (!username || channelFor(username) !== channel) {
                ctx.status = 403
                ctx.type = 'text/plain; charset=utf-8'
                ctx.body = 'forbidden'
                return ctx.stop()
            }
        }

        
        
        
        const change = detectListChange(ctx)
        if (!change) return
        const username = getCurrentUsername(ctx)
        if (!isAllowed(username)) return
        return () => {
            if (ctx.status < 200 || ctx.status >= 300) return
            if (change.requireUploadPath && !ctx.state?.uploadPath) return
            if (change.requireUploads) {
                const names = Array.isArray(ctx.state?.uploads)
                    ? ctx.state.uploads.filter(name => typeof name === 'string' && name)
                    : []
                if (!names.length) return
                refreshTargets(username, [
                    listTarget(normalizeDir(ctx.path), { added: names.map(name => ({ name })) }),
                ], { reason: 'upload' })
                return
            }
            refreshTargets(username, change.targets, { reason: change.reason })
        }
    }

    log('initialized, api', api.Const?.API_VERSION)

    return { middleware, customRest }
}
