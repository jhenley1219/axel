import { networkInterfaces } from 'os'

// Return the first non-internal IPv4 in the 192.168.x.x range — the address a
// phone on the same WiFi can reach. We deliberately ignore 10.x.x.x and
// 172.16-31.x.x because those usually belong to VPN tunnels (Tailscale,
// docker) which a phone on the local LAN can't route to.
export function getLanIp(): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (!iface.internal && iface.family === 'IPv4' && iface.address.startsWith('192.168.')) {
        return iface.address
      }
    }
  }
  return null
}
