/** Derive rate-limit identity only from an explicitly pinned reverse proxy.
 * The trusted proxy MUST replace (not forward) X-Panter-Client-IP using its own
 * validated client address. Untrusted public requests cannot spoof identity.
 */
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

function normalize(raw:string):string {
  const value=raw.startsWith('::ffff:')&&isIP(raw.slice(7))===4?raw.slice(7):raw;
  if(!isIP(value))throw new Error('Invalid peer/client IP');
  return value;
}
export class ClientAddressPolicy {
  private readonly proxies=new BlockList();
  constructor(raw:string){
    for(const entry of raw.split(',').map(x=>x.trim()).filter(Boolean)){
      const parts=entry.split('/');
      if(parts.length!==2||!/^\d+$/.test(parts[1]??''))throw new Error('Invalid trusted proxy CIDR');
      const ip=normalize(parts[0]!);const family=isIP(ip);
      const prefix=Number(parts[1]);
      if(!Number.isInteger(prefix)||prefix<1||prefix>(family===4?32:128))
        throw new Error('Invalid trusted proxy prefix');
      this.proxies.addSubnet(ip,prefix,family===4?'ipv4':'ipv6');
    }
  }
  identify(req:Pick<IncomingMessage,'socket'|'headers'>):string {
    const peer=normalize(req.socket.remoteAddress??'');
    if(!this.proxies.check(peer,isIP(peer)===4?'ipv4':'ipv6'))return peer;
    const forwarded=req.headers['x-panter-client-ip'];
    // No lists, duplicate headers or raw XFF. The trusted proxy MUST overwrite.
    if(typeof forwarded!=='string'||forwarded!==forwarded.trim()||
       forwarded.includes(',')||forwarded.includes(' ')||!isIP(forwarded))
      throw new Error('Trusted proxy must supply one validated client IP');
    return normalize(forwarded);
  }
}

/** Group IPv6 privacy addresses in one /64 quota; IPv4 addresses remain /32. */
export function rateLimitIdentity(input:string):string{
  const ip=normalize(input);
  if(isIP(ip)===4)return 'ipv4:'+ip;
  const canonical=new URL('http://['+ip+']/').hostname.slice(1,-1).toLowerCase();
  const sections=canonical.split('::');
  if(sections.length>2)throw new Error('Invalid IPv6 identity');
  const left=sections[0]?sections[0].split(':'):[];
  const right=sections.length===2&&sections[1]?sections[1].split(':'):[];
  const missing=8-left.length-right.length;
  if(missing<0)throw new Error('Invalid IPv6 expansion');
  const groups=sections.length===2?[...left,...Array(missing).fill('0'),...right]:left;
  if(groups.length!==8)throw new Error('Invalid IPv6 group count');
  return 'ipv6:/64:'+groups.slice(0,4).map(s=>s.padStart(4,'0')).join(':');
}
