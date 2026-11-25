 




'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'main.js'), 'utf8')


test.after(() => setTimeout(() => process.exit(process.exitCode || 0), 200))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function load(options = {}) {
    const state = { clip: [], username: '', uri: '', list: [], props: {} }
    const watchers = {}
    const toasts = []
    const dialogs = []
    const calls = []
    const sources = []
    const eventHandlers = new Map()
    let responder = async () => ({ ok: false })
    let reloads = 0
    let fileShow = false

    const stateProxy = new Proxy(state, {
        set(target, key, value) {
            target[key] = value
            for (const cb of watchers[key] || []) cb(value)
            return true
        },
    })

    class DirEntry {
        constructor(n) {
            this.isFolder = n.endsWith('/')
            if (this.isFolder) n = n.slice(0, -1)
            this.n = n
            this.uri = n.startsWith('/') ? n + (this.isFolder ? '/' : '') : '/' + n
            this.name = n.split('/').pop()
        }
    }

    const apiCall = (cmd, params, opts) => {
        calls.push({ cmd, params, opts })
        return responder(cmd, params, opts)
    }

    const HFS = {
        state: stateProxy,
        prefixUrl: '',
        getPluginConfig: () => options.config || {},
        watchState(key, cb, callNow) {
            (watchers[key] ||= []).push(cb)
            if (callNow) cb(state[key])
            return () => {}
        },
        apiCall,
        onEvent(name, cb) { eventHandlers.set(name, cb) },
        toast(message, type) { toasts.push({ message, type }) },
        reloadList() { reloads++ },
        dialogLib: { alertDialog: (content, type) => { dialogs.push({ content, type }); return Promise.resolve() } },
        h: (tag, props, ...children) => ({ tag, props, children }),
        t: (key, vars, fallback) => {
            if (typeof fallback === 'string') return fallback
            return Array.isArray(key) ? key[0] : String(key)
        },
        misc: {
            getPrefixUrl: () => '',
            PLUGIN_CUSTOM_REST_PREFIX: '_',
            xlate: value => String(value),
            HTTP_MESSAGES: {},
            err2msg: value => String(value?.message || value),
        },
        DirEntry,
    }

    const document = {
        hidden: false,
        addEventListener() {},
        querySelector(selector) {
            return selector === '.file-show' && fileShow ? {} : null
        },
    }

    class FakeEventSource {
        constructor(url) {
            this.url = url
            this.closed = false
            sources.push(this)
        }
        close() { this.closed = true }
    }

    const sandbox = {
        window: null,
        console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        Promise, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error,
        document,
        location: { pathname: '/Target/' },
        navigator: { userAgent: 'Mozilla/5.0 Chrome/120 Windows' },
        sessionStorage: { getItem: () => null, setItem: () => {} },
        EventSource: FakeEventSource,
        addEventListener() {},
    }
    sandbox.window = sandbox
    sandbox.window.HFS = HFS
    Object.assign(sandbox, { HFS })

    vm.runInNewContext(SOURCE, sandbox, { filename: 'main.js' })

    return {
        state: stateProxy,
        toasts,
        dialogs,
        calls,
        sources,
        DirEntry,
        reloads: () => reloads,
        setFileShow(value) { fileShow = Boolean(value) },
        setResponder(fn) { responder = fn },
        async setUsername(username) {
            stateProxy.username = username
            await sleep(20)
        },
        firePaste(params) {
            const handler = eventHandlers.get('paste')
            let prevented = false
            handler(params, { preventDefault() { prevented = true } })
            return { prevented: () => prevented }
        },
        lastCall(cmd) {
            return [...calls].reverse().find(call => call.cmd === cmd)
        },
    }
}

function snapshot(version, items, extra = {}) {
    return Object.assign({
        version,
        at: Date.now() + version,
        atISO: new Date().toISOString(),
        kind: items && items.length ? 'cut' : null,
        items: items || [],
        owner: { id: 'otherDevice', label: 'Firefox · macOS' },
        pasting: null,
        lastOp: 'op-' + version,
    }, extra)
}

test('adopts the shared clipboard on login and subscribes to the account channel', async () => {
    const page = load()
    page.setResponder(async cmd => {
        if (cmd === '_clipSync_state')
            return {
                ok: true,
                channel: 'clipSync_YQ',
                serverNow: Date.now(),
                snapshot: snapshot(1, [{ uri: '/Music/a.mp3', name: 'a.mp3' }]),
            }
        throw new Error('unexpected ' + cmd)
    })

    await page.setUsername('alice')
    await sleep(20)

    assert.equal(page.state.clip.length, 1)
    assert.equal(page.state.clip[0].uri, '/Music/a.mp3')
    assert.equal(page.sources.length, 1)
    assert.match(page.sources[0].url, /get_notifications\?channel=clipSync_YQ/)
    assert.ok(page.toasts.some(t => /Synced clipboard/.test(t.message)))
})

test('a local cut is published with UTC intent-time and client identity', async () => {
    const page = load()
    page.setResponder(async (cmd, params) => {
        if (cmd === '_clipSync_state')
            return { ok: true, channel: 'clipSync_YQ', serverNow: Date.now(), snapshot: snapshot(1, []) }
        if (cmd === '_clipSync_publish')
            return { ok: true, snapshot: snapshot(2, params.items, { owner: params.client }) }
        throw new Error('unexpected ' + cmd)
    })
    await page.setUsername('alice')

    page.state.clip = [new page.DirEntry('/Music/b.mp3')]
    await sleep(220)

    const publish = page.lastCall('_clipSync_publish')
    assert.ok(publish, 'publish must be called')
    assert.equal(publish.params.kind, 'cut')
    assert.equal(publish.params.items[0].uri, '/Music/b.mp3')
    assert.ok(Number.isFinite(publish.params.clientAt))
    assert.equal(publish.params.client.id.length > 0, true)
    assert.equal(publish.params.client.label, 'Chrome · Windows')
})

function makeEntry(uri) {
    const entry = { uri, name: uri.split('/').pop(), isFolder: uri.endsWith('/') }
    return entry
}

function listEntry(uri) {
    const isFolder = uri.endsWith('/')
    const name = uri.replace(/\/+$/, '').split('/').pop()
    return { uri, n: isFolder ? name + '/' : name, name, isFolder }
}

test('remote snapshot is applied and Paste is claimed through the server', async () => {
    const page = load()
    let serverVersion = 3
    page.setResponder(async (cmd, params) => {
        if (cmd === '_clipSync_state')
            return { ok: true, channel: 'clipSync_YQ', serverNow: Date.now(), snapshot: snapshot(serverVersion, []) }
        if (cmd === '_clipSync_paste') {
            serverVersion = 4
            return { ok: true, moved: 1, errors: [], snapshot: snapshot(serverVersion, []) }
        }
        throw new Error('unexpected ' + cmd)
    })
    await page.setUsername('alice')

    
    const source = page.sources[0]
    source.onmessage({
        data: JSON.stringify([['state', snapshot(3, [{ uri: '/Docs/report.pdf', name: 'report.pdf' }])]]),
    })
    assert.equal(page.state.clip.length, 1)
    assert.equal(page.state.clip[0].uri, '/Docs/report.pdf')

    const paste = page.firePaste({ from: page.state.clip, to: '/Target/' })
    assert.equal(paste.prevented(), true, 'must prevent the built-in paste')
    await sleep(30)

    const claim = page.lastCall('_clipSync_paste')
    assert.ok(claim)
    assert.equal(claim.params.to, '/Target/')
    assert.equal(claim.params.version, 3)
    assert.equal(page.state.clip.length, 0, 'clipboard cleared after successful paste')
})

test('cancelling a shared clipboard publishes a version-checked clear', async () => {
    const page = load()
    let version = 5
    page.setResponder(async (cmd, params) => {
        if (cmd === '_clipSync_state')
            return { ok: true, channel: 'clipSync_YQ', serverNow: Date.now(), snapshot: snapshot(version, []) }
        if (cmd === '_clipSync_publish') {
            if (params.kind === 'clear') {
                version++
                return { ok: true, snapshot: snapshot(version, []) }
            }
            return { ok: false, reason: 'unexpected' }
        }
        throw new Error('unexpected ' + cmd)
    })
    await page.setUsername('alice')

    page.sources[0].onmessage({
        data: JSON.stringify([['state', snapshot(version, [{ uri: '/Keep/me.txt', name: 'me.txt' }])]]),
    })
    assert.equal(page.state.clip.length, 1)

    const expectedBase = version
    page.state.clip = [] 
    await sleep(220)

    const clear = page.lastCall('_clipSync_publish')
    assert.ok(clear)
    assert.equal(clear.params.kind, 'clear')
    assert.equal(clear.params.baseVersion, expectedBase)
})

test('a local copy clipboard is neither published nor overwritten', async () => {
    const page = load()
    page.setResponder(async cmd => {
        if (cmd === '_clipSync_state')
            return { ok: true, channel: 'clipSync_YQ', serverNow: Date.now(), snapshot: snapshot(1, []) }
        if (cmd === '_clipSync_publish')
            return { ok: true, snapshot: snapshot(2, []) }
        throw new Error('unexpected ' + cmd)
    })
    await page.setUsername('alice')

    const copyList = [makeEntry('/Local/copy.txt')]
    copyList.__copy = true
    page.state.clip = copyList
    await sleep(220)
    assert.equal(page.calls.filter(c => c.cmd === '_clipSync_publish').length, 0,
        'copy clip must not be published')

    page.sources[0].onmessage({
        data: JSON.stringify([['state', snapshot(3, [{ uri: '/Remote/x.txt', name: 'x.txt' }])]]),
    })
    assert.equal(page.state.clip.length, 1, 'copy clip must not be overwritten by remote state')
    assert.equal(page.state.clip[0].uri, '/Local/copy.txt')
    assert.equal(page.state.clip.__copy, true)
})

test('same-page refresh events reload only the matching path and not our own action', async () => {
    const page = load()
    page.setResponder(async cmd => {
        if (cmd === '_clipSync_state')
            return { ok: true, channel: 'clipSync_YQ', serverNow: Date.now(), snapshot: snapshot(1, []) }
        if (cmd === '_clipSync_ping')
            return { ok: true, peers: 2, active: true, path: '/src/' }
        return { ok: false }
    })
    await page.setUsername('alice')
    page.state.uri = '/src/'
    await sleep(500) 

    const source = page.sources[0]
    source.onmessage({ data: JSON.stringify([['refresh', { path: '/src/', source: 'other', reason: 'comment' }]]) })
    await sleep(700)
    assert.equal(page.reloads(), 1, 'peer change reloads the list')

    const ownSession = page.lastCall('_clipSync_ping').params.sessionId
    source.onmessage({ data: JSON.stringify([['refresh', { path: '/src/', source: ownSession, reason: 'delete' }]]) })
    await sleep(700)
    assert.equal(page.reloads(), 1, 'own action does not trigger another reload')

    source.onmessage({ data: JSON.stringify([['refresh', { path: '/other/', source: 'other', reason: 'delete' }]]) })
    await sleep(700)
    assert.equal(page.reloads(), 1, 'other paths are ignored')
})

test('a page showing a file defers refresh until the viewer closes', async () => {
    const page = load()
    page.setResponder(async cmd => {
        if (cmd === '_clipSync_state')
            return { ok: true, channel: 'clipSync_YQ', serverNow: Date.now(), snapshot: snapshot(1, []) }
        if (cmd === '_clipSync_ping')
            return { ok: true, peers: 2, active: true, path: '/src/' }
        return { ok: false }
    })
    await page.setUsername('alice')
    page.state.uri = '/src/'
    await sleep(500)

    const source = page.sources[0]
    page.setFileShow(true)
    source.onmessage({ data: JSON.stringify([['refresh', { path: '/src/', source: 'other', reason: 'delete' }]]) })
    await sleep(800)
    assert.equal(page.reloads(), 0, 'must not reload under the file viewer')

    source.onmessage({ data: JSON.stringify([['refresh', { path: '/src/', source: 'other', reason: 'comment' }]]) })
    await sleep(300)
    assert.equal(page.reloads(), 0)

    page.setFileShow(false)
    await sleep(1000)
    assert.equal(page.reloads(), 1, 'queued refresh runs once after the viewer closes')
})

test('comment, rename, delete and add patches update the list without a reload', async () => {
    const page = load()
    page.setResponder(async cmd => {
        if (cmd === '_clipSync_state')
            return { ok: true, channel: 'clipSync_YQ', serverNow: Date.now(), snapshot: snapshot(1, []) }
        if (cmd === '_clipSync_ping')
            return { ok: true, peers: 2, active: true, path: '/src/' }
        return { ok: false }
    })
    await page.setUsername('alice')
    page.state.uri = '/src/'
    page.state.list = [listEntry('/src/a.txt'), listEntry('/src/b.txt')]
    await sleep(50)

    const source = page.sources[0]
    source.onmessage({
        data: JSON.stringify([['refresh', {
            path: '/src/', source: 'other', reason: 'comment',
            patch: { comment: { uri: '/src/a.txt', text: 'hello' } },
        }]]),
    })
    assert.equal(page.state.list[0].comment, 'hello')

    source.onmessage({
        data: JSON.stringify([['refresh', {
            path: '/src/', source: 'other', reason: 'rename',
            patch: { renamed: { from: '/src/a.txt', name: 'c.txt' } },
        }]]),
    })
    assert.equal(page.state.list[0].name, 'c.txt')
    assert.equal(page.state.list[0].uri, '/src/c.txt')

    source.onmessage({
        data: JSON.stringify([['refresh', {
            path: '/src/', source: 'other', reason: 'delete',
            patch: { removed: ['/src/b.txt'] },
        }]]),
    })
    assert.equal(page.state.list.some(entry => entry.uri === '/src/b.txt'), false)

    source.onmessage({
        data: JSON.stringify([['refresh', {
            path: '/src/', source: 'other', reason: 'create',
            patch: { added: [{ name: 'new-folder', isFolder: true }] },
        }]]),
    })
    assert.ok(page.state.list.some(entry => entry.uri === '/src/new-folder/'))
    assert.equal(page.reloads(), 0, 'patches must not reload the whole list')
})

test('a file viewer defers a patch and applies it without a full reload', async () => {
    const page = load()
    page.setResponder(async cmd => {
        if (cmd === '_clipSync_state')
            return { ok: true, channel: 'clipSync_YQ', serverNow: Date.now(), snapshot: snapshot(1, []) }
        if (cmd === '_clipSync_ping')
            return { ok: true, peers: 2, active: true, path: '/src/' }
        return { ok: false }
    })
    await page.setUsername('alice')
    page.state.uri = '/src/'
    page.state.list = [listEntry('/src/a.txt'), listEntry('/src/b.txt')]
    await sleep(50)

    page.setFileShow(true)
    page.sources[0].onmessage({
        data: JSON.stringify([['refresh', {
            path: '/src/', source: 'other', reason: 'delete',
            patch: { removed: ['/src/a.txt'] },
        }]]),
    })
    await sleep(150)
    assert.equal(page.state.list.length, 2, 'patch waits for the viewer')

    page.setFileShow(false)
    await sleep(800)
    assert.equal(page.state.list.length, 1)
    assert.equal(page.state.list[0].uri, '/src/b.txt')
    assert.equal(page.reloads(), 0, 'queued patch applied in place')
})

test('presence pings follow navigation, and syncList=false disables them', async () => {
    const page = load()
    page.setResponder(async cmd => {
        if (cmd === '_clipSync_state')
            return { ok: true, channel: 'clipSync_YQ', serverNow: Date.now(), snapshot: snapshot(1, []) }
        if (cmd === '_clipSync_ping')
            return { ok: true, peers: 1, active: false }
        return { ok: false }
    })
    await page.setUsername('alice')
    await sleep(50)
    const first = page.lastCall('_clipSync_ping')
    assert.ok(first, 'presence ping sent after connect')

    page.state.uri = '/Another/'
    await sleep(500)
    const latest = page.lastCall('_clipSync_ping')
    assert.equal(latest.params.path, '/Another/')

    const off = load({ config: { syncList: false } })
    off.setResponder(async cmd => {
        if (cmd === '_clipSync_state')
            return { ok: true, channel: 'clipSync_YQ', serverNow: Date.now(), snapshot: snapshot(1, []) }
        return { ok: false }
    })
    await off.setUsername('alice')
    await sleep(300)
    assert.equal(off.calls.filter(call => call.cmd === '_clipSync_ping').length, 0)
})

test('snapshots tagged with another account are ignored', async () => {
    const page = load()
    page.setResponder(async cmd => {
        if (cmd === '_clipSync_state')
            return { ok: true, channel: 'clipSync_YQ', serverNow: Date.now(), snapshot: snapshot(1, [], { account: 'alice' }) }
        if (cmd === '_clipSync_ping')
            return { ok: true, peers: 1, active: false }
        return { ok: false }
    })
    await page.setUsername('alice')

    page.sources[0].onmessage({
        data: JSON.stringify([['state', snapshot(2, [{ uri: '/Other/secret.txt', name: 'secret.txt' }], { account: 'bob' })]]),
    })
    assert.equal(page.state.clip.length, 0, 'another account must not leak into this clipboard')

    page.sources[0].onmessage({
        data: JSON.stringify([['state', snapshot(2, [{ uri: '/Mine/ok.txt', name: 'ok.txt' }], { account: 'alice' })]]),
    })
    assert.equal(page.state.clip.length, 1)
    assert.equal(page.state.clip[0].uri, '/Mine/ok.txt')
})

test('showToasts=false suppresses plugin toast messages', async () => {
    const page = load({ config: { showToasts: false } })
    page.setResponder(async cmd => {
        if (cmd === '_clipSync_state')
            return {
                ok: true,
                channel: 'clipSync_YQ',
                serverNow: Date.now(),
                snapshot: snapshot(1, [{ uri: '/Music/a.mp3', name: 'a.mp3' }], { account: 'alice' }),
            }
        if (cmd === '_clipSync_ping')
            return { ok: true, peers: 1, active: false }
        return { ok: false }
    })
    await page.setUsername('alice')
    assert.equal(page.state.clip.length, 1)
    assert.equal(page.toasts.length, 0, 'toast switch is off')
})

test('onlyFor keeps the plugin out of the way for other accounts', async () => {
    const other = load({ config: { onlyFor: ['bob'] } })
    let calls = 0
    other.setResponder(async () => { calls++; return { ok: false } })
    await other.setUsername('alice')
    assert.equal(calls, 0)
    assert.equal(other.sources.length, 0)
})
