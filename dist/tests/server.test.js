 


'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const plugin = require(path.join(__dirname, '..', 'plugin.js'))

const DEFAULTS = {
    onlyFor: [],
    syncList: true,
    debug: false,
}

function ctx(username) {
    return {
        username,
        path: '/~/api/_clipSync_state',
        query: {},
        status: 0,
        stopped: false,
        logExtra() {},
        stop() { this.stopped = true },
    }
}

function setup(options = {}) {
    const db = options.db || new Map()
    const notifications = []
    const moves = []
    const listeners = new Map()
    const config = Object.assign({}, DEFAULTS, options.config)
    let moveImpl = options.moveImpl || (async () => ({ errors: [] }))

    const api = {
        Const: { API_VERSION: 13.73, API_URI: '/~/api/', SPECIAL_URI: '/~/' },
        events: {
            on(name, cb) {
                const set = listeners.get(name) || new Set()
                set.add(cb)
                listeners.set(name, set)
                return () => set.delete(cb)
            },
        },
        require(id) {
            if (id === 'crypto') return require('node:crypto')
            if (id === './auth') return { getCurrentUsername: c => c?.username }
            if (id === './frontEndApis') {
                return {
                    async moveFiles(uris, to, c) {
                        moves.push({ uris: uris.slice(), to, username: c.username })
                        return moveImpl(uris, to, c)
                    },
                }
            }
            throw new Error('unexpected require: ' + id)
        },
        async openDb() {
            return {
                async get(key) { return db.get(key) },
                put(key, value) { db.set(key, JSON.parse(JSON.stringify(value))) },
            }
        },
        getConfig(key) { return config[key] },
        notifyClient(channel, name, data) { notifications.push({ channel, name, data }) },
        log() {},
    }
    return {
        api,
        db,
        notifications,
        moves,
        setMove(fn) { moveImpl = fn },
        emit(name, payload) {
            for (const cb of listeners.get(name) || [])
                cb(payload)
        },
        refreshEvents() {
            return notifications.filter(entry => entry.name === 'refresh').map(entry => entry.data)
        },
    }
}

async function init(env) {
    return plugin.init(env.api)
}

function cut(opId, items, extra = {}) {
    return Object.assign({
        opId,
        kind: 'cut',
        items,
        clientAt: Date.now(),
        client: { id: 'clientA', label: 'Chrome · Windows' },
    }, extra)
}

test('requires a logged-in, allowed user and isolates accounts', async () => {
    const env = setup()
    const h = await init(env)

    const anon = await h.customRest.clipSync_state({}, ctx(''))
    assert.equal(anon.ok, false)
    assert.equal(anon.reason, 'auth')

    const alice = await h.customRest.clipSync_state({}, ctx('alice'))
    const bob = await h.customRest.clipSync_state({}, ctx('bob'))
    assert.equal(alice.ok, true)
    assert.equal(bob.ok, true)
    assert.equal(alice.snapshot.account, 'alice')
    assert.equal(bob.snapshot.account, 'bob')
    assert.match(alice.channel, /^clipSync_/)
    assert.notEqual(alice.channel, bob.channel)
    assert.equal(bob.snapshot.kind, null)

    const published = await h.customRest.clipSync_publish(
        cut('a1', [{ uri: '/Music/a.mp3', name: 'a.mp3' }]),
        ctx('alice'),
    )
    assert.equal(published.ok, true)

    const bobAfter = await h.customRest.clipSync_state({}, ctx('bob'))
    assert.equal(bobAfter.snapshot.kind, null, 'bob must not see alice clipboard')
    assert.equal(bobAfter.snapshot.items.length, 0)
})

test('publish is idempotent by opId and notices duplicate retries', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    const first = await h.customRest.clipSync_publish(
        cut('op-1', [{ uri: '/a.txt', name: 'a.txt' }]),
        alice,
    )
    assert.equal(first.ok, true)
    assert.equal(first.snapshot.version, 1)
    assert.equal(first.snapshot.items.length, 1)

    const before = env.notifications.length
    const duplicate = await h.customRest.clipSync_publish(
        cut('op-1', [{ uri: '/other.txt', name: 'other.txt' }]),
        alice,
    )
    assert.equal(duplicate.ok, true)
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.snapshot.version, 1)
    assert.equal(duplicate.snapshot.items[0].uri, '/a.txt')
    assert.equal(env.notifications.length, before, 'duplicate must not broadcast')
})

test('world-time queue: stale intent is refused, accepted ops are strictly ordered', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    const first = await h.customRest.clipSync_publish(
        cut('w1', [{ uri: '/a.txt', name: 'a.txt' }], { clientAt: Date.now() - 60_000 }),
        alice,
    )
    assert.equal(first.ok, true)

    const stale = await h.customRest.clipSync_publish(
        cut('w2', [{ uri: '/b.txt', name: 'b.txt' }], { clientAt: Date.now() - 60_000 }),
        alice,
    )
    assert.equal(stale.ok, false)
    assert.equal(stale.reason, 'stale')

    const fresh = await h.customRest.clipSync_publish(
        cut('w3', [{ uri: '/c.txt', name: 'c.txt' }], { clientAt: Date.now() + 60_000 }),
        alice,
    )
    assert.equal(fresh.ok, true)
    assert.ok(fresh.snapshot.at > first.snapshot.at)

    const second = await h.customRest.clipSync_publish(
        cut('w4', [{ uri: '/d.txt', name: 'd.txt' }], { clientAt: Date.now() + 60_000 }),
        alice,
    )
    assert.ok(second.snapshot.version > fresh.snapshot.version)
    assert.ok(second.snapshot.at > fresh.snapshot.at)
})

test('clear requires the expected version', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    const published = await h.customRest.clipSync_publish(
        cut('c1', [{ uri: '/a.txt', name: 'a.txt' }]),
        alice,
    )
    const version = published.snapshot.version

    const wrong = await h.customRest.clipSync_publish(
        { opId: 'c2', kind: 'clear', baseVersion: version - 1 },
        alice,
    )
    assert.equal(wrong.ok, false)
    assert.equal(wrong.reason, 'stale')

    const cleared = await h.customRest.clipSync_publish(
        { opId: 'c3', kind: 'clear', baseVersion: version },
        alice,
    )
    assert.equal(cleared.ok, true)
    assert.equal(cleared.snapshot.kind, null)
    assert.equal(cleared.snapshot.items.length, 0)
})

test('paste: atomic claim, one move, clipboard cleared, duplicate op ignored', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    const published = await h.customRest.clipSync_publish(
        cut('p1', [
            { uri: '/Music/a.mp3', name: 'a.mp3' },
            { uri: '/Music/b.mp3', name: 'b.mp3' },
        ]),
        alice,
    )

    const pasted = await h.customRest.clipSync_paste({
        opId: 'paste-1',
        version: published.snapshot.version,
        to: '/Target/',
        client: { id: 'clientA', label: 'Chrome' },
    }, alice)
    assert.equal(pasted.ok, true)
    assert.equal(pasted.moved, 2)
    assert.equal(env.moves.length, 1)
    assert.deepEqual(env.moves[0].uris, ['/Music/a.mp3', '/Music/b.mp3'])
    assert.equal(env.moves[0].to, '/Target/')
    assert.equal(pasted.snapshot.kind, null)
    assert.equal(env.moves[0].username, 'alice')
    assert.equal(pasted.snapshot.owner, null)

    const duplicate = await h.customRest.clipSync_paste({
        opId: 'paste-1',
        version: published.snapshot.version,
        to: '/Target/',
        client: { id: 'clientA', label: 'Chrome' },
    }, alice)
    assert.equal(duplicate.ok, true)
    assert.equal(duplicate.duplicate, true)
    assert.equal(env.moves.length, 1, 'duplicate paste must not move again')

    const again = await h.customRest.clipSync_paste({
        opId: 'paste-2',
        version: pasted.snapshot.version,
        to: '/Target/',
        client: { id: 'clientA', label: 'Chrome' },
    }, alice)
    assert.equal(again.ok, false)
    assert.equal(again.reason, 'empty')
    assert.equal(env.moves.length, 1)
})

test('paste refuses stale version and same-folder targets', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    const v1 = await h.customRest.clipSync_publish(
        cut('s1', [{ uri: '/Target/a.txt', name: 'a.txt' }]),
        alice,
    )
    const same = await h.customRest.clipSync_paste({
        opId: 'sp1', version: v1.snapshot.version, to: '/Target/',
        client: { id: 'x', label: 'x' },
    }, alice)
    assert.equal(same.ok, false)
    assert.equal(same.reason, 'same')
    assert.equal(env.moves.length, 0)

    const v2 = await h.customRest.clipSync_publish(
        cut('s2', [{ uri: '/Source/a.txt', name: 'a.txt' }]),
        alice,
    )
    const stale = await h.customRest.clipSync_paste({
        opId: 'sp2', version: v1.snapshot.version, to: '/Dest/',
        client: { id: 'x', label: 'x' },
    }, alice)
    assert.equal(stale.ok, false)
    assert.equal(stale.reason, 'stale')
    assert.equal(env.moves.length, 0)
    assert.equal(v2.snapshot.items[0].uri, '/Source/a.txt')
})

test('only one device can paste the same clipboard version (busy claim)', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    let release
    env.setMove(() => new Promise(resolve => { release = resolve }))

    const published = await h.customRest.clipSync_publish(
        cut('b1', [{ uri: '/a.txt', name: 'a.txt' }]),
        alice,
    )

    const first = h.customRest.clipSync_paste({
        opId: 'bp1', version: published.snapshot.version, to: '/D/',
        client: { id: 'A', label: 'A' },
    }, alice)
    await new Promise(resolve => setImmediate(resolve))

    const second = await h.customRest.clipSync_paste({
        opId: 'bp2', version: published.snapshot.version, to: '/D/',
        client: { id: 'B', label: 'B' },
    }, alice)
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'busy')

    const overwrite = await h.customRest.clipSync_publish(
        cut('b3', [{ uri: '/b.txt', name: 'b.txt' }]),
        alice,
    )
    assert.equal(overwrite.ok, false)
    assert.equal(overwrite.reason, 'busy')

    release({ errors: [] })
    const firstResult = await first
    assert.equal(firstResult.ok, true)
    assert.equal(env.moves.length, 1)
    assert.equal(firstResult.snapshot.kind, null)
})

test('partial move failure keeps only the failed items on the shared clipboard', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    env.setMove(async () => ({ errors: [null, 'EPERM'] }))
    const published = await h.customRest.clipSync_publish(
        cut('pf', [
            { uri: '/a.txt', name: 'a.txt' },
            { uri: '/b.txt', name: 'b.txt' },
        ]),
        alice,
    )

    const result = await h.customRest.clipSync_paste({
        opId: 'pf-paste', version: published.snapshot.version, to: '/D/',
        client: { id: 'A', label: 'A' },
    }, alice)
    assert.equal(result.ok, true)
    assert.equal(result.moved, 1)
    assert.equal(result.snapshot.kind, 'cut')
    assert.equal(result.snapshot.items.length, 1)
    assert.equal(result.snapshot.items[0].uri, '/b.txt')
    assert.equal(result.snapshot.owner.id, 'A')
})

test('destination-level failure (ApiError-like result) leaves every item', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    env.setMove(async () => ({ code: 403, message: 'Forbidden' }))
    const published = await h.customRest.clipSync_publish(
        cut('df', [{ uri: '/a.txt', name: 'a.txt' }]),
        alice,
    )
    const result = await h.customRest.clipSync_paste({
        opId: 'df-paste', version: published.snapshot.version, to: '/D/',
        client: { id: 'A', label: 'A' },
    }, alice)
    assert.equal(result.ok, true)
    assert.equal(result.moved, 0)
    assert.deepEqual(result.errors, [403])
    assert.equal(result.snapshot.items.length, 1)
    assert.equal(result.snapshot.kind, 'cut')
})

test('state survives a plugin re-init (persistent account record)', async () => {
    const db = new Map()
    const env1 = setup({ db })
    const h1 = await init(env1)
    await h1.customRest.clipSync_publish(
        cut('persist-1', [{ uri: '/keep.txt', name: 'keep.txt' }]),
        ctx('alice'),
    )

    const env2 = setup({ db })
    const h2 = await init(env2)
    const state = await h2.customRest.clipSync_state({}, ctx('alice'))
    assert.equal(state.snapshot.kind, 'cut')
    assert.equal(state.snapshot.items[0].uri, '/keep.txt')
    assert.ok(state.snapshot.version >= 1)
})

test('notification channel is bound to the account', async () => {
    const env = setup()
    const h = await init(env)
    const state = await h.customRest.clipSync_state({}, ctx('alice'))
    const channel = state.channel

    const ok = Object.assign(ctx('alice'), {
        path: '/~/api/get_notifications',
        query: { channel },
    })
    await h.middleware(ok)
    assert.equal(ok.stopped, false)
    assert.equal(ok.status, 0)

    const bad = Object.assign(ctx('bob'), {
        path: '/~/api/get_notifications',
        query: { channel },
    })
    await h.middleware(bad)
    assert.equal(bad.stopped, true)
    assert.equal(bad.status, 403)

    const anon = Object.assign(ctx(''), {
        path: '/~/api/get_notifications',
        query: { channel },
    })
    await h.middleware(anon)
    assert.equal(anon.stopped, true)
    assert.equal(anon.status, 403)
})

test('onlyFor configuration restricts both API and channel', async () => {
    const env = setup({ config: { onlyFor: ['alice'] } })
    const h = await init(env)

    const alice = await h.customRest.clipSync_state({}, ctx('alice'))
    assert.equal(alice.ok, true)

    const bob = await h.customRest.clipSync_state({}, ctx('bob'))
    assert.equal(bob.ok, false)
    assert.equal(bob.reason, 'auth')
})

test('presence: a path becomes active only with 2+ visible pages', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    const one = await h.customRest.clipSync_ping(
        { sessionId: 's1', path: '/src/', visible: true }, alice)
    assert.equal(one.ok, true)
    assert.equal(one.peers, 1)
    assert.equal(one.active, false)

    const two = await h.customRest.clipSync_ping(
        { sessionId: 's2', path: '/src/', visible: true }, alice)
    assert.equal(two.peers, 2)
    assert.equal(two.active, true)

    const moved = await h.customRest.clipSync_ping(
        { sessionId: 's2', path: '/dst/', visible: true }, alice)
    assert.equal(moved.peers, 1)
    assert.equal(moved.active, false)

    const back = await h.customRest.clipSync_ping(
        { sessionId: 's1', path: '/src/', visible: true }, alice)
    assert.equal(back.peers, 1, 's2 moved away from /src/')
    assert.equal(back.active, false)

    const hidden = await h.customRest.clipSync_ping(
        { sessionId: 's2', path: '/src/', visible: false }, alice)
    const hiddenPeers = await h.customRest.clipSync_ping(
        { sessionId: 's1', path: '/src/', visible: true }, alice)
    assert.equal(hiddenPeers.peers, 1, 'hidden pages do not count as active peers')
    assert.equal(hiddenPeers.active, false)
    assert.equal(hidden.ok, true)
})

test('paste refreshes an affected address only when a page is there', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    await h.customRest.clipSync_ping({ sessionId: 's1', path: '/src/', visible: true }, alice)
    await h.customRest.clipSync_ping({ sessionId: 's2', path: '/src/', visible: true }, alice)

    const published = await h.customRest.clipSync_publish(
        cut('r1', [{ uri: '/src/c.txt', name: 'c.txt' }]),
        alice,
    )
    const pasted = await h.customRest.clipSync_paste({
        opId: 'r-paste',
        version: published.snapshot.version,
        to: '/dst/',
        source: 's1',
        client: { id: 'devA', label: 'A' },
    }, alice)
    assert.equal(pasted.ok, true)

    const refreshes = env.refreshEvents()
    assert.ok(refreshes.some(event => event.path === '/src/'), 'source folder with 2 pages refreshes')
    assert.ok(!refreshes.some(event => event.path === '/dst/'), 'single page destination does not refresh')
    assert.equal(refreshes.find(event => event.path === '/src/').source, 's1')
    assert.equal(refreshes.find(event => event.path === '/src/').reason, 'paste')
})

test('two-end operations refresh both source and destination, not unrelated addresses', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    await h.customRest.clipSync_ping({ sessionId: 'source', path: '/src/', visible: true }, alice)
    await h.customRest.clipSync_ping({ sessionId: 'dest', path: '/dst/', visible: true }, alice)
    await h.customRest.clipSync_ping({ sessionId: 'elsewhere', path: '/other/', visible: true }, alice)

    const published = await h.customRest.clipSync_publish(
        cut('two-end', [{ uri: '/src/c.txt', name: 'c.txt' }]),
        alice,
    )
    const pasted = await h.customRest.clipSync_paste({
        opId: 'two-end-paste',
        version: published.snapshot.version,
        to: '/dst/',
        source: 'source',
        client: { id: 'devA', label: 'A' },
    }, alice)
    assert.equal(pasted.ok, true)

    const paths = env.refreshEvents().map(event => event.path)
    assert.ok(paths.includes('/src/'), 'source end refreshes with a single page there')
    assert.ok(paths.includes('/dst/'), 'destination end refreshes with a single page there')
    assert.ok(!paths.includes('/other/'), 'unrelated address never refreshes')
    assert.deepEqual(env.refreshEvents().find(x => x.path === '/src/').patch.removed, ['/src/c.txt'])
    assert.deepEqual(env.refreshEvents().find(x => x.path === '/dst/').patch.added,
        [{ name: 'c.txt', isFolder: false }])
})

test('a single page does not produce refresh-list traffic', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    await h.customRest.clipSync_ping({ sessionId: 'alone', path: '/src/', visible: true }, alice)
    const published = await h.customRest.clipSync_publish(
        cut('r2', [{ uri: '/src/c.txt', name: 'c.txt' }]),
        alice,
    )
    await h.customRest.clipSync_paste({
        opId: 'r2-paste',
        version: published.snapshot.version,
        to: '/dst/',
        source: 'alone',
        client: { id: 'devA', label: 'A' },
    }, alice)

    assert.equal(env.refreshEvents().length, 0)
})

test('delete API refreshes the parent folder after success (2 pages)', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    await h.customRest.clipSync_ping({ sessionId: 's1', path: '/src/', visible: true }, alice)
    await h.customRest.clipSync_ping({ sessionId: 's2', path: '/src/', visible: true }, alice)

    const request = {
        username: 'alice',
        method: 'DELETE',
        path: '/src/a.txt',
        query: {},
        status: 200,
    }
    const after = await h.middleware(request)
    assert.equal(typeof after, 'function')
    assert.equal(env.refreshEvents().length, 0, 'must wait for the delete to complete')
    after()
    const refreshes = env.refreshEvents()
    assert.equal(refreshes.length, 1)
    assert.equal(refreshes[0].path, '/src/')
    assert.equal(refreshes[0].reason, 'delete')
    assert.deepEqual(refreshes[0].patch.removed, ['/src/a.txt'])

    
    const denied = {
        username: 'alice',
        method: 'DELETE',
        path: '/src/a.txt',
        query: {},
        status: 403,
    }
    const deniedAfter = await h.middleware(denied)
    deniedAfter()
    assert.equal(env.refreshEvents().length, 1)
})

test('comment API refreshes the parent folder after success', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    await h.customRest.clipSync_ping({ sessionId: 's1', path: '/src/', visible: true }, alice)
    await h.customRest.clipSync_ping({ sessionId: 's2', path: '/src/', visible: true }, alice)

    const request = {
        username: 'alice',
        path: '/~/api/comment',
        query: {},
        state: { params: { uri: '/src/a.txt', comment: 'hello' } },
        status: 200,
    }
    const after = await h.middleware(request)
    assert.equal(typeof after, 'function')
    after()

    const refreshes = env.refreshEvents()
    assert.equal(refreshes.length, 1)
    assert.equal(refreshes[0].path, '/src/')
    assert.equal(refreshes[0].reason, 'comment')
    assert.deepEqual(refreshes[0].patch.comment, { uri: '/src/a.txt', text: 'hello' })
})

test('rename/copy/upload also go through the merged list-change detector', async () => {
    const env = setup()
    const h = await init(env)
    const alice = ctx('alice')

    await h.customRest.clipSync_ping({ sessionId: 's1', path: '/src/', visible: true }, alice)
    await h.customRest.clipSync_ping({ sessionId: 's2', path: '/src/', visible: true }, alice)
    await h.customRest.clipSync_ping({ sessionId: 's3', path: '/dst/', visible: true }, alice)

    async function afterOf(request) {
        const after = await h.middleware(Object.assign({
            username: 'alice', query: {}, status: 200,
        }, request))
        assert.equal(typeof after, 'function', request.path)
        after()
        return env.refreshEvents().at(-1)
    }

    let event = await afterOf({
        method: 'POST',
        path: '/~/api/rename',
        state: { params: { uri: '/src/a.txt', dest: 'b.txt' } },
    })
    assert.equal(event.path, '/src/')
    assert.equal(event.reason, 'rename')
    assert.deepEqual(event.patch.renamed, { from: '/src/a.txt', name: 'b.txt' })

    event = await afterOf({
        method: 'POST',
        path: '/~/api/create_folder',
        state: { params: { uri: '/src/', name: 'New folder' } },
    })
    assert.equal(event.reason, 'create')
    assert.deepEqual(event.patch.added, [{ name: 'New folder', isFolder: true }])

    event = await afterOf({
        method: 'POST',
        path: '/~/api/copy_files',
        state: { params: { uri_from: ['/src/a.txt'], uri_to: '/dst/' } },
    })
    assert.equal(event.path, '/dst/')
    assert.equal(event.reason, 'copy_files')
    assert.ok(!env.refreshEvents().some(x => x.reason === 'copy_files' && x.path === '/src/'),
        'copy does not change the source list')

    event = await afterOf({
        method: 'PUT',
        path: '/src/new.txt',
        state: { uploadPath: '/src/new.txt' },
    })
    assert.equal(event.path, '/src/')
    assert.equal(event.reason, 'upload')

    event = await afterOf({
        method: 'POST',
        path: '/src/',
        state: { uploads: ['new.txt'] },
    })
    assert.equal(event.path, '/src/')
    assert.equal(event.reason, 'upload')

    
    const before = env.refreshEvents().length
    const after = await h.middleware({
        username: 'alice', method: 'POST', path: '/src/', query: {}, status: 200, state: {},
    })
    if (after) after()
    assert.equal(env.refreshEvents().length, before)
})

test('operations from different accounts are isolated and spaced on the queue timeline', async () => {
    const env = setup()
    const h = await init(env)

    const alice = await h.customRest.clipSync_publish(
        cut('gap-a', [{ uri: '/a.txt', name: 'a.txt' }]),
        ctx('alice'),
    )
    const bob = await h.customRest.clipSync_publish(
        cut('gap-b', [{ uri: '/b.txt', name: 'b.txt' }]),
        ctx('bob'),
    )
    assert.equal(alice.snapshot.account, 'alice')
    assert.equal(bob.snapshot.account, 'bob')
    assert.ok(bob.snapshot.at - alice.snapshot.at >= 50, 'accepted operations are time-spaced')

    const aliceState = await h.customRest.clipSync_state({}, ctx('alice'))
    const bobState = await h.customRest.clipSync_state({}, ctx('bob'))
    assert.equal(aliceState.snapshot.items[0].uri, '/a.txt')
    assert.equal(bobState.snapshot.items[0].uri, '/b.txt')
})

test('guests cannot use the clipboard API', async () => {
    const env = setup()
    const h = await init(env)

    const request = {
        username: undefined,
        path: '/~/api/_clipSync_state',
        query: {},
        status: 0,
        stopped: false,
        stop() { this.stopped = true },
    }
    await h.middleware(request)
    assert.equal(request.stopped, true)
    assert.equal(request.status, 401)

    const loggedIn = {
        username: 'alice',
        path: '/~/api/_clipSync_state',
        query: {},
        status: 0,
        stopped: false,
        stop() { this.stopped = true },
    }
    await h.middleware(loggedIn)
    assert.equal(loggedIn.stopped, false)
})

test('syncList=false keeps clipboard sync but disables presence/refresh', async () => {
    const env = setup({ config: { syncList: false } })
    const h = await init(env)
    const alice = ctx('alice')

    const ping = await h.customRest.clipSync_ping(
        { sessionId: 's1', path: '/src/', visible: true }, alice)
    assert.equal(ping.ok, false)
    assert.equal(ping.reason, 'disabled')

    const published = await h.customRest.clipSync_publish(
        cut('off-list', [{ uri: '/src/a.txt', name: 'a.txt' }]),
        alice,
    )
    assert.equal(published.ok, true)
    const pasted = await h.customRest.clipSync_paste({
        opId: 'off-list-paste',
        version: published.snapshot.version,
        to: '/dst/',
        client: { id: 'A', label: 'A' },
    }, alice)
    assert.equal(pasted.ok, true)
    assert.equal(env.refreshEvents().length, 0)
})
