'use strict';
(() => {
     













    const HFS = window.HFS
    if (!HFS || !HFS.state || !HFS.watchState) return

    const conf = HFS.getPluginConfig?.() || {}

    const REST_PREFIX = HFS.misc?.PLUGIN_CUSTOM_REST_PREFIX ?? '_'
    const CHANNEL_PREFIX = 'clipSync_'
    const CLIENT_ID = getClientId()
    const CLIENT_LABEL = describeBrowser()
    const ONLY_FOR = Array.isArray(conf.onlyFor) ? conf.onlyFor : conf.onlyFor ? [conf.onlyFor] : []
    const POLL_MS = 20_000 
    const SYNC_LIST = conf.syncList !== false
    const SHOW_TOASTS = conf.showToasts !== false
    const DEBUG = Boolean(conf.debug)
    
    const SESSION_ID = 's' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

    let session = null
    let applying = false            
    let publishTimer = 0
    let retryTimer = 0
    let refreshTimer = 0
    let presenceTimer = 0
    let reloadTimer = 0
    let showCheckTimer = 0
    let pendingShowEvents = []
    let opChain = Promise.resolve()
    let pending = null             
    let pendingClear = null        // 'cut' | 'copy' | null
    let lastPublishedSig = ''
    let lastToastVersion = -1
    let retryCount = 0
    let lastRefresh = 0
    let clipInfo = { active: false, copy: false, sig: '' }
    let remoteClip = null   
    let opSeq = 0

    function log(...args) {
        if (DEBUG) console.log('[Clipboard-Sync]', ...args)
    }

    function itemsLabel(n) {
        return `${n} item${n === 1 ? '' : 's'}`
    }

    function notify(message, type) {
        if (!SHOW_TOASTS) return
        try { HFS.toast(message, type) }
        catch (e) { log('toast failed', e) }
    }

    function getClientId() {
        try {
            const key = 'hfsClipSyncClientId'
            let id = sessionStorage.getItem(key)
            if (!id) {
                id = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
                sessionStorage.setItem(key, id)
            }
            return id
        }
        catch {
            return 'c' + Math.random().toString(36).slice(2, 10)
        }
    }

    function describeBrowser() {
        const ua = navigator.userAgent || ''
        const os = /Windows/i.test(ua) ? 'Windows'
            : /Android/i.test(ua) ? 'Android'
                : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
                    : /Mac OS X/i.test(ua) ? 'macOS'
                        : /Linux/i.test(ua) ? 'Linux'
                            : 'Web'
        const browser = /Edg\//i.test(ua) ? 'Edge'
            : /OPR\//i.test(ua) ? 'Opera'
                : /Firefox\//i.test(ua) ? 'Firefox'
                    : /Chrome\//i.test(ua) ? 'Chrome'
                        : /Safari\//i.test(ua) ? 'Safari'
                            : 'Browser'
        return `${browser} · ${os}`
    }

    function newOpId() {
        return `${CLIENT_ID}-${Date.now().toString(36)}-${(++opSeq).toString(36)}`
    }

    function apiBase() {
        let prefix = ''
        try {
            const fn = HFS.misc?.getPrefixUrl
            if (typeof fn === 'function') prefix = fn()
        }
        catch {}
        if (typeof prefix !== 'string')
            prefix = typeof HFS.prefixUrl === 'string' ? HFS.prefixUrl : ''
        return prefix + '/~/api/'
    }

    function rest(name, params, options) {
        return HFS.apiCall(REST_PREFIX + name, params || {}, options)
    }

    function currentUsername() {
        try { return HFS.state.username || '' }
        catch { return '' }
    }

    function isAllowedUser(username) {
        return Boolean(username) && (!ONLY_FOR.length || ONLY_FOR.includes(username))
    }

    function safeDecode(value) {
        try { return decodeURI(String(value)) }
        catch { return String(value) }
    }

    function clipSignature(list) {
        if (!Array.isArray(list)) return ''
        const out = []
        for (const entry of list)
            if (entry && typeof entry.uri === 'string') out.push(entry.uri)
        return out.join('\n')
    }

    function itemsSignature(items) {
        if (!Array.isArray(items)) return ''
        return items.map(item => item.uri || '').join('\n')
    }

    function toEntry(item) {
        if (!item || typeof item.uri !== 'string') return
        let path = item.uri
        try { path = decodeURI(item.uri) }
        catch {}
        try {
            const entry = new HFS.DirEntry(path)
            entry.uri = item.uri 
            if (typeof item.name === 'string' && item.name) {
                try { entry.name = item.name }
                catch {}
            }
            return entry
        }
        catch (e) {
            log('cannot rebuild entry', item.uri, e)
        }
    }

    function noteClip(clip) {
        clipInfo = {
            active: Boolean(clip?.length),
            copy: Boolean(clip?.__copy),
            sig: clipSignature(clip),
        }
    }

     
     
     

    function syncIdentity() {
        const username = currentUsername()
        if (!isAllowedUser(username)) return teardown()
        if (session?.username === username) return
        teardown()
        session = {
            username,
            channel: null,
            version: -1,
            at: 0,
            kind: null,
            owner: null,
            items: [],
            pasting: null,
            copySupported: false,
            ready: false,
            connecting: false,
            skew: 0,
            es: null,
            pollTimer: 0,
            connectTimer: 0,
            presenceTimer: 0,
            peers: 0,
            active: false,
            presencePath: '',
            reloadTimer: 0,
        }
        connect()
    }

    function connect() {
        const s = session
        if (!s || s.ready || s.connecting) return
        s.connecting = true
        rest('clipSync_state').then(res => {
            if (session !== s) return
            s.connecting = false
            if (!res?.ok) {
                if (res?.reason === 'auth') return teardown()
                return scheduleConnect(s)
            }
            s.ready = true
            s.channel = res.channel
            s.skew = (Number(res.serverNow) || Date.now()) - Date.now()
            onSnapshot(res.snapshot, { initial: true })
            openStream()
            startPolling()
            startPresence()
            lastPublishedSig = ''
            flushLocal()
            log('connected', s.channel)
        }, err => {
            if (session !== s) return
            s.connecting = false
            log('state request failed', err)
            scheduleConnect(s)
        })
    }

    function scheduleConnect(s) {
        if (!s || s.ready) return
        clearTimeout(s.connectTimer)
        s.connectTimer = setTimeout(() => {
            if (session === s) connect()
        }, 3000)
    }

     
     
     

    function currentPath() {
        try { return HFS.state.uri || location.pathname || '/' }
        catch { return '/' }
    }

    function normPath(value) {
        let p = String(value || '')
        try { p = decodeURI(p) }
        catch {}
        if (!p.startsWith('/')) p = '/' + p
        if (!p.endsWith('/')) p += '/'
        return p
    }

    function pingPresence(s) {
        s = s || session
        if (!SYNC_LIST || !s?.ready || session !== s) return
        rest('clipSync_ping', {
            sessionId: SESSION_ID,
            path: currentPath(),
            visible: !document.hidden,
            client: { id: CLIENT_ID, label: CLIENT_LABEL },
        }).then(res => {
            if (session !== s || !res?.ok) return
            s.peers = Number(res.peers) || 0
            s.active = Boolean(res.active)
            s.presencePath = res.path || ''
        }, err => log('presence ping failed', err))
    }

    function startPresence() {
        const s = session
        if (!SYNC_LIST || !s) return
        clearInterval(s.presenceTimer)
        pingPresence(s)
        s.presenceTimer = setInterval(() => {
            if (session === s) pingPresence(s)
        }, POLL_MS)
    }

    function schedulePing() {
        if (!SYNC_LIST) return
        clearTimeout(presenceTimer)
        presenceTimer = setTimeout(() => {
            if (session?.ready) pingPresence(session)
        }, 350)
    }

    function onRefreshEvent(data) {
        if (!SYNC_LIST || !session?.ready) return
        if (!data || typeof data.path !== 'string') return
        
        if (data.source && data.source === SESSION_ID && !data.patch) return
        if (normPath(data.path) !== normPath(currentPath())) return
        log('refresh requested', data.path, data.reason)
        if (fileShowOpen()) return queueShowEvent(data)
        if (!applyListPatch(data)) scheduleListReload()
    }

    function fileShowOpen() {
        try { return Boolean(document.querySelector('.file-show')) }
        catch { return false }
    }

    function joinUri(base, name, isFolder) {
        const dir = String(base || '')
        const prefix = dir.endsWith('/') ? dir : dir + '/'
        let encoded
        try {
            encoded = HFS.misc?.pathEncode ? HFS.misc.pathEncode(name) : encodeURIComponent(name)
        }
        catch {
            encoded = encodeURIComponent(name)
        }
        return prefix + encoded + (isFolder ? '/' : '')
    }

     



    function applyListPatch(data) {
        const patch = data?.patch
        if (!patch || typeof patch !== 'object') return false
        const state = HFS.state
        if (!Array.isArray(state.list)) return false
        if (state.loading) return false
        if (state.remoteSearch) return false
        const lists = [state.list]
        if (Array.isArray(state.filteredList)) lists.push(state.filteredList)

        if (patch.folderComment !== undefined) {
            if (!state.props) state.props = {}
            state.props.comment = patch.folderComment
        }

        if (patch.comment) {
            const { uri, text } = patch.comment
            if (typeof uri !== 'string') return false
            for (const list of lists) {
                const entry = list.find(item => item?.uri === uri)
                if (entry) entry.comment = text
            }
        }

        if (patch.renamed) {
            const { from, name } = patch.renamed
            if (typeof from !== 'string' || typeof name !== 'string' || !name) return false
            for (const list of lists) {
                const index = list.findIndex(item => item?.uri === from)
                if (index < 0) continue
                const entry = list[index]
                if (entry.name === name) continue 
                const baseN = entry.n.endsWith('/') ? entry.n.slice(0, -1) : entry.n
                const prefix = baseN.slice(0, baseN.lastIndexOf('/') + 1)
                const n = prefix + name + (entry.isFolder ? '/' : '')
                let next
                try {
                    next = new HFS.DirEntry(n, Object.assign({}, entry, { key: entry.key || entry.n }))
                }
                catch { return false }
                next.uri = joinUri(data.path, name, entry.isFolder)
                list[index] = next
            }
        }

        if (Array.isArray(patch.removed) && patch.removed.length) {
            const removed = new Set(patch.removed.filter(uri => typeof uri === 'string'))
            for (const list of lists)
                for (let i = list.length - 1; i >= 0; i--)
                    if (removed.has(list[i]?.uri)) list.splice(i, 1)
        }

        if (Array.isArray(patch.added) && patch.added.length) {
            
            if (state.filteredList) return false
            for (const item of patch.added) {
                if (!item || typeof item.name !== 'string' || !item.name) continue
                const isFolder = Boolean(item.isFolder)
                const uri = joinUri(data.path, item.name, isFolder)
                if (state.list.some(entry => entry?.uri === uri)) continue
                let entry
                try {
                    entry = new HFS.DirEntry(item.name + (isFolder ? '/' : ''))
                }
                catch { return false }
                entry.uri = uri
                if (Number.isFinite(item.size)) entry.s = item.size
                if (item.mtime) {
                    const date = new Date(item.mtime)
                    if (!isNaN(date)) entry.m = date
                }
                state.list.push(entry)
            }
        }

        return true
    }

    function queueShowEvent(data) {
        if (pendingShowEvents.length < 100) pendingShowEvents.push(data)
        if (showCheckTimer) return
        showCheckTimer = setInterval(() => {
            if (fileShowOpen()) return
            clearInterval(showCheckTimer)
            showCheckTimer = 0
            const events = pendingShowEvents.splice(0)
            let needReload = false
            for (const event of events) {
                if (!event) continue
                if (event.path && normPath(event.path) !== normPath(currentPath())) continue
                if (event.full) {
                    needReload = true
                    continue
                }
                if (!applyListPatch(event)) needReload = true
            }
            if (needReload) reloadListNow()
        }, 500)
    }

    function reloadListNow() {
        clearTimeout(reloadTimer)
        reloadTimer = 0
        pendingShowEvents.length = 0
        try { HFS.reloadList?.() }
        catch (e) { log('reloadList failed', e) }
    }

    function scheduleListReload() {
        clearTimeout(reloadTimer)
        reloadTimer = setTimeout(() => {
            
            
            if (fileShowOpen()) return queueShowEvent({ full: true, path: currentPath() })
            reloadListNow()
        }, 450)
    }

    function openStream() {
        closeStream()
        const s = session
        if (!s?.channel) return
        let es
        try {
            es = new EventSource(apiBase() + 'get_notifications?channel=' + encodeURIComponent(s.channel))
        }
        catch (e) {
            log('EventSource unavailable', e)
            return
        }
        s.es = es
        es.onopen = () => {
            log('stream open')
            
            clearTimeout(refreshTimer)
            refreshTimer = setTimeout(() => {
                if (session !== s) return
                refresh(true)
                pingPresence(s)
            }, 250)
        }
        es.onmessage = ev => {
            if (!ev.data || session !== s) return
            let payload
            try { payload = JSON.parse(ev.data) }
            catch { return }
            handleStreamPayload(payload)
        }
        es.onerror = () => {
            
            log('stream error')
            refreshSoon(1500)
        }
    }

    function handleStreamPayload(payload) {
        if (!Array.isArray(payload)) return
        if (payload.length === 2 && typeof payload[0] === 'string')
            return handleEvent(payload[0], payload[1])
        for (const pair of payload)
            if (Array.isArray(pair) && typeof pair[0] === 'string')
                handleEvent(pair[0], pair[1])
    }

    function handleEvent(name, data) {
        if (name === 'state') onSnapshot(data)
        else if (name === 'refresh') onRefreshEvent(data)
    }

    function closeStream() {
        if (session?.es) {
            try { session.es.close() }
            catch {}
            session.es = null
        }
    }

    function startPolling() {
        const s = session
        if (!s) return
        clearInterval(s.pollTimer)
        s.pollTimer = setInterval(() => {
            if (!document.hidden) refresh()
        }, POLL_MS)
    }

    function refresh(force) {
        const s = session
        if (!s?.ready) return
        const now = Date.now()
        if (!force && now - lastRefresh < 1500) return
        lastRefresh = now
        rest('clipSync_state').then(res => {
            if (session !== s || !res?.ok) {
                if (res?.reason === 'auth' && session === s) teardown()
                return
            }
            if (res.channel && res.channel !== s.channel) {
                s.channel = res.channel
                openStream()
            }
            s.skew = (Number(res.serverNow) || Date.now()) - Date.now()
            onSnapshot(res.snapshot)
        }, err => log('refresh failed', err))
    }

    function refreshSoon(delay) {
        clearTimeout(refreshTimer)
        refreshTimer = setTimeout(() => refresh(true), delay || 1000)
    }

    function teardown() {
        closeStream()
        if (session) {
            clearInterval(session.pollTimer)
            clearInterval(session.presenceTimer)
            clearTimeout(session.connectTimer)
        }
        clearTimeout(publishTimer)
        clearInterval(copyClearTimer)
        copyClearTimer = 0
        clearTimeout(retryTimer)
        clearTimeout(refreshTimer)
        clearTimeout(presenceTimer)
        clearTimeout(reloadTimer)
        clearInterval(showCheckTimer)
        showCheckTimer = 0
        pendingShowEvents = []
        session = null
        pending = null
        pendingClear = null
        lastPublishedSig = ''
        lastToastVersion = -1
        retryCount = 0
    }

     
     
     

    function onSnapshot(snapshot, options) {
        options = options || {}
        const s = session
        if (!s || !snapshot) return
        
        
        if (snapshot.account && snapshot.account !== s.username) {
            log('ignoring snapshot for another account', snapshot.account)
            return
        }
        const version = Number(snapshot.version)
        if (!Number.isFinite(version)) return
        if (version < s.version) return

        
        
        if (pending && !options.force && version <= pending.versionAtChange
            && snapshot.lastOp !== pending.opId)
            return

        s.version = version
        s.at = Number(snapshot.at) || 0
        s.kind = snapshot.kind || null
        s.owner = snapshot.owner || null
        s.copySupported = Boolean(snapshot.copySupported)
        s.pasting = snapshot.pasting || null
        s.items = Array.isArray(snapshot.items) ? snapshot.items : []
        if (pending && (snapshot.lastOp === pending.opId || version > pending.versionAtChange))
            pending = null

        applyClip(snapshot, options)
    }

    function applyClip(snapshot) {
        const s = session
        if (!s) return
        const clip = HFS.state.clip
        const items = Array.isArray(snapshot.items) ? snapshot.items : []
        const copy = snapshot.kind === 'copy'

        if ((snapshot.kind === 'cut' || copy) && items.length) {
            if (copy && !s.copySupported) return
            // Our own copy publish can return after copy-files already cleared
            // the local clipboard. Do not resurrect it: clear the server side.
            if (copy && !clip?.length && snapshot.owner?.id === CLIENT_ID) {
                pendingClear = 'copy'
                remoteClip = null
                clearTimeout(publishTimer)
                publishTimer = setTimeout(flushLocal, 10)
                return
            }
            const sig = itemsSignature(items)
            const currentSig = clipSignature(clip)
            if (sig !== currentSig || Boolean(clip?.__copy) !== copy) {
                const entries = items.map(toEntry).filter(Boolean)
                if (!entries.length) return
                if (copy) entries.__copy = true
                applying = true
                try { HFS.state.clip = entries }
                finally { applying = false }
            }
            
            
            remoteClip = HFS.state.clip
            noteClip(remoteClip)
            lastPublishedSig = ''
            if (snapshot.owner?.id !== CLIENT_ID && snapshot.version > lastToastVersion) {
                lastToastVersion = snapshot.version
                const who = snapshot.owner?.label || ''
                const label = copy ? 'Synced copy clipboard' : 'Synced clipboard'
                const msg = who
                    ? `${label}: ${itemsLabel(items.length)} from ${who}`
                    : `${label}: ${itemsLabel(items.length)}`
                notify(msg, 'info')
            }
        }
        else {
            remoteClip = null
            if (clip?.length) {
                applying = true
                try { HFS.state.clip = [] }
                finally { applying = false }
                noteClip([])
            }
        }
    }

     
     
     

    function onClipChange(clip) {
        if (applying) return
        const prev = clipInfo
        noteClip(clip)

        if (!clip?.length && prev.active) {
            pendingClear = prev.copy ? 'copy' : 'cut'
        }
        else if (clip?.length) {
            pendingClear = null
        }

        clearTimeout(publishTimer)
        clearInterval(copyClearTimer)
        copyClearTimer = 0
        publishTimer = setTimeout(flushLocal, 120)
    }

    // copy-files clears the clipboard with `clip.length = 0`, which is an
    // in-place mutation and may not fire watchState. Watch the exact array that
    // was pasted until it empties or is replaced, then publish the clear.
    let copyClearTimer = 0
    function watchCopyClear(clip) {
        clearInterval(copyClearTimer)
        const started = Date.now()
        copyClearTimer = setInterval(() => {
            if (!session || HFS.state.clip !== clip || !clip?.__copy
                || !clip.length || Date.now() - started > 30 * 60_000) {
                clearInterval(copyClearTimer)
                copyClearTimer = 0
                if (session && HFS.state.clip === clip && clip && !clip.length)
                    onClipChange(clip)
            }
        }, 500)
    }

    function flushLocal() {
        const s = session
        if (!s?.ready) return
        const clip = HFS.state.clip
        const copy = Boolean(clip?.__copy)
        if (copy && !s.copySupported) return
        // An empty array can still be the same object that was synced (copy-files
        // clears it in place), so only suppress the echo while it has content.
        if (remoteClip && clip === remoteClip && clip?.length) return 

        if (!clip?.length) {
            if (!pendingClear) return
            const clearKind = pendingClear
            pendingClear = null
            if (s.kind !== clearKind) return
            enqueue(() => doPublish(s, { kind: 'clear', baseVersion: s.version }, clearKind))
            return
        }

        const items = []
        for (const entry of clip) {
            if (!entry?.uri) continue
            items.push({
                uri: entry.uri,
                name: entry.name || entry.uri.split('/').filter(Boolean).pop() || entry.uri,
                isFolder: Boolean(entry.isFolder) || entry.uri.endsWith('/'),
            })
        }
        if (!items.length) return
        const kind = copy ? 'copy' : 'cut'
        const fullSig = kind + ':' + itemsSignature(items)
        if (fullSig === lastPublishedSig) return
        enqueue(() => doPublish(s, { kind, items }))
    }

    function enqueue(task) {
        opChain = opChain.then(task).catch(e => log('operation failed', e))
        return opChain
    }

    async function doPublish(s, body, clearIntent) {
        if (session !== s || !s.ready) return
        const itemKind = body.kind === 'cut' || body.kind === 'copy'
        const sig = itemKind ? itemsSignature(body.items) : ''
        const fullSig = itemKind ? body.kind + ':' + sig : ''
        if (itemKind && fullSig === lastPublishedSig) return

        const opId = newOpId()
        pending = { opId, versionAtChange: s.version }
        const payload = Object.assign({}, body, {
            opId,
            clientAt: Date.now() + s.skew,
            client: { id: CLIENT_ID, label: CLIENT_LABEL },
        })

        let res
        try {
            res = await rest('clipSync_publish', payload)
        }
        catch (e) {
            pending = null
            if (body.kind === 'clear') pendingClear = clearIntent || 'cut'
            log('publish failed', e)
            return schedulePublishRetry()
        }
        if (session !== s) return

        if (res?.ok) {
            pending = null
            retryCount = 0
            if (itemKind) lastPublishedSig = fullSig
            if (res.snapshot) onSnapshot(res.snapshot)
            return
        }
        pending = null
        if (res?.reason === 'copy-unsupported') {
            s.copySupported = false
            notify('Copy clipboard sync needs the copy-files plugin. Local copy kept only.', 'warning')
            return
        }
        if (res?.reason === 'busy') {
            
            if (body.kind === 'clear') pendingClear = clearIntent || 'cut'
            return schedulePublishRetry(1200)
        }
        if (res?.reason === 'stale') {
            if (res.snapshot) onSnapshot(res.snapshot, { force: true })
            notify('Clipboard was updated by another device. Latest state loaded; try again if needed.', 'warning')
            return
        }
        if (res?.reason === 'auth') {
            notify('Session expired. Cross-device clipboard sync stopped.', 'error')
            return teardown()
        }
    }

    function schedulePublishRetry(delay) {
        if (!session?.ready || retryCount >= 4) return
        retryCount++
        clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
            if (session?.ready) flushLocal()
        }, delay || 2500)
    }

     
     
     

    HFS.onEvent('paste', (params, extra) => {
        const from = params?.from
        const to = params?.to
        if (!session?.ready || !to) return
        if (!Array.isArray(from) || !from.length) return
        if (from.__copy) {
            if (session?.copySupported) watchCopyClear(from)
            return
        }
        extra.preventDefault()
        const list = Array.from(from)
        enqueue(() => doPaste(list, to))
    })

    async function doPaste(list, to) {
        const s = session
        if (!s?.ready) return legacyMove(list, to)
        if (clipSignature(list) !== clipSignature(HFS.state.clip)) {
            notify('Clipboard changed. Paste cancelled.', 'warning')
            return
        }

        const version = s.version
        const opId = newOpId()
        let res
        try {
            res = await rest('clipSync_paste', {
                opId,
                version,
                to,
                source: SESSION_ID,
                clientAt: Date.now() + s.skew,
                client: { id: CLIENT_ID, label: CLIENT_LABEL },
            }, { timeout: false })
        }
        catch (e) {
            log('paste request failed', e)
            
            
            notify('Could not confirm the paste result (connection lost). The server may still be moving files; refresh later to check.', 'warning')
            refreshSoon(2000)
            return
        }
        if (session !== s) return

        if (!res?.ok) {
            if (res?.snapshot) onSnapshot(res.snapshot, { force: true })
            const reason = res?.reason
            if (reason === 'stale')
                notify('Clipboard was updated by another device. Press Paste again.', 'warning')
            else if (reason === 'busy')
                notify('Another device is pasting this clipboard. Please wait.', 'warning')
            else if (reason === 'empty')
                notify('Clipboard is empty.', 'info')
            else if (reason === 'same')
                notify('Destination folder is the same as the source folder.', 'warning')
            else if (reason === 'auth') {
                notify('Session expired. Cross-device clipboard sync stopped.', 'error')
                teardown()
            }
            return
        }

        if (res.snapshot) onSnapshot(res.snapshot, { force: true })
        reportMove(list, res.errors || [])
    }

    async function legacyMove(list, to) {
        try {
            const res = await HFS.apiCall('move_files', {
                uri_from: list.map(entry => entry.uri),
                uri_to: to,
            })
            const errors = res?.errors || []
            reportMove(list, errors)
            if (!errors.some(Boolean)) {
                applying = true
                try { HFS.state.clip = [] }
                finally { applying = false }
                noteClip([])
            }
            try { HFS.reloadList?.() }
            catch {}
        }
        catch (e) {
            const msg = HFS.misc?.err2msg ? HFS.misc.err2msg(e) : (e?.message || String(e))
            HFS.dialogLib.alertDialog(msg)
        }
    }

    function reportMove(list, errors) {
        const bad = errors.filter(Boolean).length
        const good = list.length - bad
        const msg = `${good} moved${bad ? `, ${bad} failed` : ''}`
        if (!bad) {
            notify(msg, 'success')
            return
        }
        const h = HFS.h
        const rows = []
        errors.forEach((error, i) => {
            if (!error) return
            const label = HFS.misc?.xlate ? HFS.misc.xlate(error, HFS.misc.HTTP_MESSAGES) : String(error)
            rows.push(h('li', {}, `${list[i]?.name || list[i]?.uri || i}: ${label}`))
        })
        HFS.dialogLib.alertDialog(h('div', {}, msg, h('ul', {}, rows)), 'warning')
    }

     
     
     

    HFS.watchState('clip', onClipChange, true)
    HFS.watchState('username', syncIdentity, true)
    HFS.watchState('uri', () => schedulePing(), true)

    
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            if (!session?.es || session.es.readyState !== 1) refresh(true)
            pingPresence(session)
        }
        else
            pingPresence(session)
    })
    window.addEventListener('focus', () => {
        refreshSoon(500)
        pingPresence(session)
    })
    window.addEventListener('online', () => {
        refresh(true)
        pingPresence(session)
    })

    log('loaded', { CLIENT_ID, CLIENT_LABEL })
})();
