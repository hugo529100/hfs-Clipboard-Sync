 


'use strict'

const base = process.argv[2] || 'http://127.0.0.1:8899'
const channel = process.argv[3]
const cookie = process.argv[4] || ''
const timeoutMs = Number(process.argv[5] || 10000)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
    if (!channel) throw new Error('missing channel')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const res = await fetch(`${base}/~/api/get_notifications?channel=${encodeURIComponent(channel)}`, {
        headers: { cookie, accept: 'text/event-stream' },
        signal: controller.signal,
    })
    if (res.status !== 200) throw new Error('SSE status ' + res.status)
    console.log('SSE_CONNECTED')

    const opId = 'sse-' + Date.now()
    const items = [{ uri: '/src/c.txt', name: 'c.txt' }]
    const published = await fetch(`${base}/~/api/_clipSync_publish`, {
        method: 'POST',
        headers: {
            cookie,
            'content-type': 'application/json',
            'x-hfs-anti-csrf': '1',
        },
        body: JSON.stringify({
            opId,
            kind: 'cut',
            items,
            clientAt: Date.now(),
            client: { id: 'sse-device', label: 'SSE test' },
        }),
    })
    const publishBody = await published.text()
    console.log('PUBLISH ' + published.status + ' ' + publishBody.slice(0, 160))
    if (!published.ok) throw new Error('publish failed')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let received = null
    while (!received) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, cut)
            buffer = buffer.slice(cut + 2)
            for (const line of block.split('\n')) {
                if (!line.startsWith('data:')) continue
                const payload = line.slice(5).trim()
                if (!payload) continue
                let parsed
                try { parsed = JSON.parse(payload) }
                catch { continue }
                const pairs = Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed : [parsed]
                for (const pair of pairs) {
                    if (!Array.isArray(pair)) continue
                    const [name, data] = pair
                    if (name !== 'state') continue
                    if (data?.lastOp === opId) {
                        received = data
                        break
                    }
                }
            }
        }
    }
    controller.abort()
    clearTimeout(timer)
    if (!received) throw new Error('no matching live state event')
    console.log('SSE_EVENT ' + JSON.stringify({
        version: received.version,
        kind: received.kind,
        items: received.items?.map(x => x.uri),
        owner: received.owner,
        atISO: received.atISO,
    }))
}

main().then(() => process.exit(0), err => {
    console.error('SSE_FAILED ' + err.message)
    process.exit(2)
})
