/* Rasterise the generated composition SVG with the local deterministic
 * rasteriser so design comparison is reproducible and cache-free. */
import fs from 'node:fs'
import R from './rasterize.mjs'

const F4=[244,248,252], CYAN=[0,210,255], BG=[0,0,0];
function mul(a,b){ // CTM composition: result = b * a (b is the outer/parent CTM).
  return [b[0]*a[0]+b[2]*a[1], b[1]*a[0]+b[3]*a[1], b[0]*a[2]+b[2]*a[3], b[1]*a[2]+b[3]*a[3], b[0]*a[4]+b[2]*a[5]+b[4], b[1]*a[4]+b[3]*a[5]+b[5]];
}
function apply(m,p){return [m[0]*p[0]+m[2]*p[1]+m[4], m[1]*p[0]+m[3]*p[1]+m[5]];}
function parseTransform(s){
  let m=[1,0,0,1,0,0];
  const re=/(translate|scale|matrix|rotate)\s*\(([^)]*)\)/g; let t;
  while((t=re.exec(s))){
    const v=t[2].split(/[\s,]+/).filter(x=>x.length).map(Number);
    let n=[1,0,0,1,0,0];
    if(t[1]==='translate') n=[1,0,0,1,v[0]||0,v[1]||0];
    else if(t[1]==='scale') n=[v[0],0,0,v.length>1?v[1]:v[0],0,0];
    else if(t[1]==='matrix') n=v;
    else if(t[1]==='rotate'){const a=(v[0]||0)*Math.PI/180,c=Math.cos(a),si=Math.sin(a);n=[c,si,-si,c,0,0];}
    m=mul(n,m);
  }
  return m;
}
function colorOf(s){
  const three=s.match(/#([0-9a-f])([0-9a-f])([0-9a-f])(?![0-9a-f])/i);
  if(three) return [parseInt(three[1]+three[1],16), parseInt(three[2]+three[2],16), parseInt(three[3]+three[3],16)];
  const six=s.match(/#([0-9a-f]{6})/i);
  if(six){const v=parseInt(six[1],16);return [(v>>16)&255,(v>>8)&255,v&255];}
  if(/00d2ff/i.test(s)) return CYAN;
  if(/f4f8fc/i.test(s)) return F4;
  return F4;
}
function renderSVG(svgStr,W,H,SS){
  const acc=new Float32Array(W*H*3); // 0..1 coverage accumulators per channel
  const cov=new Float32Array(W*H);   // paint coverage
  let stack=[[1,0,0,1,0,0]];
  let fillStack=['#f4f8fc'], strokeStack=[null];
  const tagRe=/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g; let t;
  const els=[];
  while((t=tagRe.exec(svgStr))){
    const close=t[1]==='/', name=t[2].toLowerCase(), attrs=t[3], self=t[4]==='/';
    if(close){ stack.pop(); if(stack.length<fillStack.length){ fillStack.pop(); strokeStack.pop(); } continue; }
    const get=(k)=>{const m=attrs.match(new RegExp('[\\s]'+k+'="([^"]*)"'));return m?m[1]:null;};
    const tf=get('transform');
    const cur=stack[stack.length-1];
    const local=tf?parseTransform(tf):[1,0,0,1,0,0];
    const m=mul(local,cur);
    if(!self){
      stack.push(m);
      const fAttr=(attrs.match(/[\s]fill="([^"]*)"/)||[])[1]||null;
      const sAttr=(attrs.match(/[\s]stroke="([^"]*)"/)||[])[1]||null;
      // only groups propagate paint; a shape carries its own
      if(name==='g'||name==='svg'){ fillStack.push(fAttr||fillStack[fillStack.length-1]); strokeStack.push(sAttr||strokeStack[strokeStack.length-1]); }
    }
    if(name==='rect'||name==='circle'||name==='path'){
      els.push({name,attrs,get,m,
        inheritedFill:fillStack[fillStack.length-1],
        inheritedStroke:strokeStack[strokeStack.length-1]});
    }
  }
  // pass 1: compute shape masks and paint
  for(const e of els){
    const m=e.m;
    const stroke=e.get('stroke')||e.inheritedStroke;
    const fillAttr=e.get('fill')||e.inheritedFill;
    const sw=e.get('stroke-width');
    const subsInk=[];  // polygons to fill
    const centre=[];   // stroke centrelines (device space)
    let isStroke=false, strokeW=0;
    const poly=(sub)=>sub.map(p=>apply(m,p));
    if(e.name==='rect'){
      const x=+e.get('x'),y=+e.get('y'),w=+e.get('width'),h=+e.get('height'),rx=+(e.get('rx')||0);
      for(const s of R.rectPath(x,y,w,h,rx)) subsInk.push(poly(s));
    } else if(e.name==='circle'){
      const cx=+e.get('cx'),cy=+e.get('cy'),r=+e.get('r');
      for(const s of R.circlePath(cx,cy,r)) subsInk.push(poly(s));
    } else {
      const d=e.get('d');
      const subs=R.parsePath(d);
      if(stroke){
        // transform the centreline, then stroke it in device space
        for(const s of subs) centre.push(s.map(p=>apply(m,p)));
        isStroke=true;
        strokeW=(+sw||1)*Math.hypot(m[0],m[1]);
      } else {
        for(const s of subs) subsInk.push(poly(s));
      }
    }
    const color=colorOf(stroke||fillAttr||'#f4f8fc');
    const {mask,w,h}= isStroke ? R.strokeMask(centre,strokeW,W,H,SS) : R.fillMask(subsInk,W,H,SS,'evenodd');
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      let s=0;for(let dy=0;dy<SS;dy++)for(let dx=0;dx<SS;dx++)s+=mask[(y*SS+dy)*w+(x*SS+dx)];
      const a=s/(SS*SS); if(a<=0)continue;
      const o=(y*W+x)*3;
      for(let c=0;c<3;c++) acc[o+c]=acc[o+c]*(1-a)+color[c]*a;
    }
  }
  const out=Buffer.alloc(W*H*3);
  for(let i=0;i<W*H;i++)for(let c=0;c<3;c++) out[i*3+c]=Math.round(acc[i*3+c]);
  return out;
}
export { renderSVG }
