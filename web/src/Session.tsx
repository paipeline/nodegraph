import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'

/**
 * The real claude TUI for one Node, in a real pty on the other end.
 *
 * The socket is only a window: the agent belongs to the server and keeps
 * running whether or not anyone is looking, so closing this pane — by picking
 * another Node, or by closing the tab — never interrupts it.
 */

type AgentStatus =
  | { state: 'connecting' }
  | { state: 'running' }
  | { state: 'exited'; exitCode: number }
  | { state: 'lost' }
  | { state: 'error'; message: string }

type Frame =
  | { type: 'opened'; nodeId: string; workspacePath: string; status: AgentStatus; data: string }
  | { type: 'output'; data: string }
  | { type: 'exited'; exitCode: number }
  | { type: 'error'; message: string }

const socketUrl = (nodeId: string): string => {
  const url = new URL(`/session?node=${encodeURIComponent(nodeId)}`, window.location.href)
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

const describe = (status: AgentStatus): string => {
  switch (status.state) {
    case 'connecting':
      return 'connecting…'
    case 'running':
      return 'running'
    case 'exited':
      return `ended · exit ${status.exitCode}`
    case 'lost':
      return 'disconnected'
    case 'error':
      return status.message
  }
}

export const Session = ({ nodeId, label }: { nodeId: string; label: string }) => {
  const host = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<AgentStatus>({ state: 'connecting' })
  const [workspacePath, setWorkspacePath] = useState('')

  useEffect(() => {
    const element = host.current
    if (element === null) return

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#0f1115', foreground: '#e6e9ef' },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)

    const socket = new WebSocket(socketUrl(nodeId))

    // A TUI draws itself to fit, so the pty has to be told the size of the box
    // it is actually being drawn in — on open, and every time the box changes.
    const tellSize = () => {
      fit.fit()
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
      }
    }

    socket.addEventListener('open', tellSize)
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as Frame
      switch (frame.type) {
        case 'opened':
          setWorkspacePath(frame.workspacePath)
          setStatus(frame.status)
          terminal.write(frame.data)
          tellSize()
          break
        case 'output':
          terminal.write(frame.data)
          break
        case 'exited':
          setStatus({ state: 'exited', exitCode: frame.exitCode })
          break
        case 'error':
          setStatus({ state: 'error', message: frame.message })
          break
      }
    })
    socket.addEventListener('close', () => {
      setStatus((current) => (current.state === 'connecting' ? { state: 'lost' } : current))
    })

    const typing = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }))
      }
    })

    const resizes = new ResizeObserver(tellSize)
    resizes.observe(element)

    return () => {
      resizes.disconnect()
      typing.dispose()
      socket.close()
      terminal.dispose()
    }
  }, [nodeId])

  return (
    <section className="session">
      <header className="session__head">
        <span className="session__label">{label}</span>
        <span className={`session__status session__status--${status.state}`}>
          {describe(status)}
        </span>
        <span className="session__path" title={workspacePath}>
          {workspacePath}
        </span>
      </header>
      <div className="session__screen" ref={host} />
    </section>
  )
}
