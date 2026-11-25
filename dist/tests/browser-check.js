 


'use strict'

const port = Number(process.argv[2] || 9333)
const url = process.argv[3] || 'http://127.0.0.1:8899/'
const waitMs = Number(process.argv[4] || 7000)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find(x => x.type === 'page')
    if (!page) throw new Error('no page target')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
        ws.onopen = resolve
        ws.onerror = reject
    })

    let nextId = 0
    const pending = new Map()
    const errors = []
    ws.onmessage = event => {
        const msg = JSON.parse(event.data)
        if (msg.id) {
            const item = pending.get(msg.id)
            if (!item) return
            pending.delete(msg.id)
            return msg.error ? item.reject(new Error(JSON.stringify(msg.error))) : item.resolve(msg.result)
        }
        if (msg.method === 'Runtime.exceptionThrown')
            errors.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text)
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error')
            errors.push(msg.params.args?.map(a => a.value ?? a.description).join(' '))
    }

    function send(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++nextId
            pending.set(id, { resolve, reject })
            ws.send(JSON.stringify({ id, method, params }))
            setTimeout(() => {
                if (pending.delete(id)) reject(new Error('CDP timeout: ' + method))
            }, 15000)
        })
    }

    await send('Runtime.enable')
    await send('Page.enable')
    await send('Page.navigate', { url })
    await sleep(waitMs)

    const expression = `(() => {
        const clip = window.HFS && window.HFS.state && window.HFS.state.clip
        return JSON.stringify({
            href: location.href,
            title: document.title,
            clipBar: !!document.getElementById('clipBar'),
            clipCount: clip ? clip.length : null,
            clipUris: clip ? Array.from(clip, x => x.uri) : null,
            syncMeta: clip && clip.__sync ? { version: clip.__sync.version, at: clip.__sync.at } : null,
            username: window.HFS && window.HFS.state ? window.HFS.state.username : null,
        })
    })()`
    const result = await send('Runtime.evaluate', { expression, returnByValue: true })
    const value = result.result?.value
    console.log(value || JSON.stringify(result))
    if (errors.length)
        console.log('PAGE_ERRORS ' + JSON.stringify(errors.slice(0, 20)))
    ws.close()
}

main().catch(err => {
    console.error('CHECK_FAILED', err.message)
    process.exit(2)
})
