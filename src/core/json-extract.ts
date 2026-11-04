/** Locating JSON objects that remote hosts return inside prose, fences or bare. Pure, linear-ish, bounded. */
/** Top-level balanced {...} spans of a text, string-aware. An unclosed '{' or '"' in prose does not hide what follows:
 * the scan restarts after it (a bounded number of times). */
export function objectSpans(text:string){
  const out:string[]=[];
  let from=0;
  for(let restarts=0;restarts<32&&from<text.length;restarts++){
    let depth=0,start=-1,inString=false,escaped=false,i=from;
    for(;i<text.length;i++){
      const c=text[i];
      if(inString){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')inString=false;continue;}
      if(c==='"'&&depth>0){inString=true;continue;}
      if(c==='{'){if(depth===0)start=i;depth++;}
      else if(c==='}'&&depth>0){depth--;if(depth===0)out.push(text.slice(start,i+1));}
    }
    if(depth===0)break;
    from=start+1;
  }
  return out;
}
/** Bodies of fenced code blocks, found line by line (linear time). */
export function fencedBlocks(text:string){
  const out:string[]=[];const lines=text.split('\n');let open=-1;
  for(let i=0;i<lines.length;i++){
    const line=lines[i]!.trim();
    if(open<0){if(/^```[a-zA-Z0-9_-]*$/.test(line))open=i;}
    else if(line==='```'){out.push(lines.slice(open+1,i).join('\n').trim());open=-1;}
  }
  return out;
}
/** Every place a JSON object may be: the whole text, each fenced block, each balanced top-level object. */
export function jsonCandidates(text:string){return [text.trim(),...fencedBlocks(text),...objectSpans(text)];}
