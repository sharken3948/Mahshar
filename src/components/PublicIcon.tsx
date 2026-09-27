export type PublicIconName = 'agent' | 'api' | 'arrow' | 'auth' | 'balance' | 'book' | 'bridge' | 'code' | 'discover' | 'docs' | 'execute' | 'help' | 'mail' | 'payment' | 'provider' | 'recovery' | 'terminal' | 'wallet'

export function PublicIcon({ name }: { name: PublicIconName }) {
  const paths: Record<PublicIconName, React.ReactNode> = {
    agent: <><rect x="5" y="7" width="14" height="12" rx="3" /><path d="M12 3v4M9 12h.01M15 12h.01M2 12h3M19 12h3" /></>,
    api: <><path d="M8 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="m14 8-4 8M8 10l-2 2 2 2M16 10l2 2-2 2" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    auth: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
    balance: <><path d="M4 7.5h16a2 2 0 0 1 2 2V19H6a2 2 0 0 1-2-2V7.5Z" /><path d="M4 8V6a2 2 0 0 1 2-2h13v3.5M17 12h6v4h-6a2 2 0 0 1 0-4Z" /></>,
    book: <><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v18H7.5A3.5 3.5 0 0 0 4 23V5.5Z" /><path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H13v18h3.5A3.5 3.5 0 0 1 20 23V5.5Z" /></>,
    bridge: <><path d="M4 8h16M4 16h16" /><path d="m8 4-4 4 4 4m8 0 4 4-4 4" /></>,
    code: <><path d="m9 7-5 5 5 5M15 7l5 5-5 5M14 4l-4 16" /></>,
    discover: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5" /></>,
    docs: <><path d="M6 3h9l4 4v14H6V3Z" /><path d="M15 3v5h4M9 12h6M9 16h6" /></>,
    execute: <><path d="M5 4h14v16H5z" /><path d="m8 9 3 3-3 3M13 15h3" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.8 9a2.4 2.4 0 1 1 3.2 2.27c-.62.25-1 .88-1 1.55V14M12 18h.01" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>,
    payment: <><circle cx="12" cy="12" r="9" /><path d="M15 8.5h-4.5a2 2 0 0 0 0 4H13a2 2 0 0 1 0 4H8.5M12 6v2.5M12 16.5V19" /></>,
    provider: <><path d="M5 4h14v6H5zM5 14h14v6H5z" /><path d="M8 7h.01M8 17h.01M11 7h5M11 17h5" /></>,
    recovery: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6" /><path d="M4 4v4.6h4.6" /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M12 15h5" /></>,
    wallet: <><path d="M4 7h16a2 2 0 0 1 2 2v10H6a2 2 0 0 1-2-2V7Z" /><path d="M4 8V6a2 2 0 0 1 2-2h13M17 12h6v4h-6a2 2 0 0 1 0-4Z" /></>,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}
