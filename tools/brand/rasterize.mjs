/* Deterministic, dependency-free SVG rasteriser for the shapes this repo's
 * brand composition uses (rect / circle / path with M L H V A Q C Z).
 * Curves are flattened adaptively, then scanline-filled with the even-odd rule
 * (the only fill rule we use) at 4x supersampling. */
import fs from 'node:fs'
import zlib from 'node:zlib'

function parsePath(d){
  const toks=d.match(/[MmLlHhVvAaQqCcZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi)||[];
  let i=0, cmd=null, x=0,y=0, sx=0,sy=0; const subs=[]; let cur=[];
  const num=()=>parseFloat(toks[i++]);
  const push=(px,py)=>{cur.push([px,py]);};
  while(i<toks.length){
    const t=toks[i];
    if(/[MmLlHhVvAaQqCcZz]/.test(t)){ cmd=t; i++; }
    switch(cmd){
      case 'M': case 'm':{
        let nx=num(), ny=num();
        if(cmd==='m'){nx+=x;ny+=y;}
        if(cur.length) subs.push(cur);
        cur=[]; x=nx;y=ny;sx=x;sy=y; push(x,y); cmd = cmd==='M'?'L':'l'; break;}
      case 'L': case 'l':{ let nx=num(),ny=num(); if(cmd==='l'){nx+=x;ny+=y;} x=nx;y=ny; push(x,y); break;}
      case 'H': case 'h':{ let nx=num(); if(cmd==='h')nx+=x; x=nx; push(x,y); break;}
      case 'V': case 'v':{ let ny=num(); if(cmd==='v')ny+=y; y=ny; push(x,y); break;}
      case 'Q': case 'q':{ let c1x=num(),c1y=num(),nx=num(),ny=num();
        if(cmd==='q'){c1x+=x;c1y+=y;nx+=x;ny+=y;}
        const p0=[x,y],p1=[c1x,c1y],p2=[nx,ny];
        const m=Math.max(Math.abs(p0[0]-2*p1[0]+p2[0]),Math.abs(p0[1]-2*p1[1]+p2[1]));
        const N=Math.max(2,Math.min(64,Math.ceil(Math.sqrt(m)/0.4)));
        for(let k=1;k<=N;k++){const t=k/N,u=1-t;cur.push([u*u*p0[0]+2*u*t*p1[0]+t*t*p2[0], u*u*p0[1]+2*u*t*p1[1]+t*t*p2[1]]);}
        x=nx;y=ny; break;}
      case 'C': case 'c':{ let c1x=num(),c1y=num(),c2x=num(),c2y=num(),nx=num(),ny=num();
        if(cmd==='c'){c1x+=x;c1y+=y;c2x+=x;c2y+=y;nx+=x;ny+=y;}
        const p0=[x,y],p1=[c1x,c1y],p2=[c2x,c2y],p3=[nx,ny];
        const m=Math.max(Math.abs(-p0[0]+3*p1[0]-3*p2[0]+p3[0]),Math.abs(-p0[1]+3*p1[1]-3*p2[1]+p3[1]),
                         Math.abs(p0[0]-2*p1[0]+p2[0]),Math.abs(p0[1]-2*p1[1]+p2[1]),
                         Math.abs(p1[0]-2*p2[0]+p3[0]),Math.abs(p1[1]-2*p2[1]+p3[1]));
        const N=Math.max(3,Math.min(96,Math.ceil(Math.sqrt(m)/0.4)));
        for(let k=1;k<=N;k++){const t=k/N,u=1-t;
          cur.push([u*u*u*p0[0]+3*u*u*t*p1[0]+3*u*t*t*p2[0]+t*t*t*p3[0],
                u*u*u*p0[1]+3*u*u*t*p1[1]+3*u*t*t*p2[1]+t*t*t*p3[1]]);}
        x=nx;y=ny; break;}
      case 'A': case 'a':{
        let rx=num(),ry=num(),rot=num(),laf=num(),sf=num(),nx=num(),ny=num();
        if(cmd==='a'){nx+=x;ny+=y;}
        const pts=arc(x,y,rx,ry,rot,laf,sf,nx,ny); for(const p of pts) cur.push(p); x=nx;y=ny; break;}
      case 'Z': case 'z':{ if(cur.length){push(sx,sy); subs.push(cur); cur=[];} x=sx;y=sy; break;}
      default: i++; break;
    }
  }
  if(cur.length) subs.push(cur);
  return subs;
}
function arc(x1,y1,rx,ry,phiDeg,laf,sf,x2,y2){
  if(rx===0||ry===0) return [[x2,y2]];
  const phi=phiDeg*Math.PI/180, cos=Math.cos(phi), sin=Math.sin(phi);
  const dx2=(x1-x2)/2, dy2=(y1-y2)/2;
  const x1p= cos*dx2+sin*dy2, y1p=-sin*dx2+cos*dy2;
  let rxs=rx*rx, rys=ry*ry, x1ps=x1p*x1p, y1ps=y1p*y1p;
  let lam=x1ps/rxs+y1ps/rys;
  if(lam>1){const s=Math.sqrt(lam); rx*=s; ry*=s; rxs=rx*rx; rys=ry*ry;}
  const sign=(laf!==sf)?1:-1;
  let num=rxs*rys-rxs*y1ps-rys*x1ps, den=rxs*y1ps+rys*x1ps;
  let co=sign*Math.sqrt(Math.max(0,num/den));
  const cxp=co*(rx*y1p/ry), cyp=co*(-ry*x1p/rx);
  const cx=cos*cxp-sin*cyp+(x1+x2)/2, cy=sin*cxp+cos*cyp+(y1+y2)/2;
  const ang=(ux,uy,vx,vy)=>{
    const n1=Math.hypot(ux,uy), n2=Math.hypot(vx,vy);
    if(n1===0||n2===0) return 0;                     // degenerate: radii fit a semicircle
    const d=(ux*vx+uy*vy)/(n1*n2);
    const cross=ux*vy-uy*vx;
    const mag=Math.acos(Math.max(-1,Math.min(1,d)));
    return (cross<0? -mag : mag);
  };
  const t1=ang(1,0,(x1p-cxp)/rx,(y1p-cyp)/ry);
  let dt=ang((x1p-cxp)/rx,(y1p-cyp)/ry,(-x1p-cxp)/rx,(-y1p-cyp)/ry);
  if(dt===0){ // exact semicircle: sweep 180 degrees in the requested direction
    dt = sf ? Math.PI : -Math.PI;
  }
  if(!sf&&dt>0) dt-=2*Math.PI;
  if(sf&&dt<0) dt+=2*Math.PI;
  const N=Math.max(2,Math.min(128,Math.ceil(Math.abs(dt)/0.04)));
  const out=[];
  for(let k=1;k<=N;k++){const t=t1+dt*k/N;
    out.push([cx+cos*rx*Math.cos(t)-sin*ry*Math.sin(t), cy+sin*rx*Math.cos(t)+cos*ry*Math.sin(t)]);}
  return out;
}
function rectPath(x,y,w,h,r=0){
  const p=[];
  if(!r) return [[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]];
  const k=0.5522847498*r;
  const seg=[[x+r,y],[x+w-r,y],[x+w-r+k,y,x+w,y+r-k,x+w,y+r],[x+w,y+h-r],[x+w,y+h-r+k,x+w-r+k,y+h,x+w-r,y+h],
             [x+r,y+h],[x+r-k,y+h,x,y+h-r+k,x,y+h-r],[x,y+r],[x,y+r-k,x+r-k,y,x+r,y]];
  const sub=[]; let cur=[];
  const add=(pt)=>{cur.push(pt);};
  add([x+r,y]); add([x+w-r,y]);
  for(let i=1;i<seg.length;i++){}
  // build explicitly
  cur=[[x+r,y],[x+w-r,y]];
  const bez=(p0,p1,p2,p3)=>{const N=10;for(let i=1;i<=N;i++){const t=i/N,u=1-t;
    cur.push([u*u*u*p0[0]+3*u*u*t*p1[0]+3*u*t*t*p2[0]+t*t*t*p3[0], u*u*u*p0[1]+3*u*u*t*p1[1]+3*u*t*t*p2[1]+t*t*t*p3[1]]);}};
  bez([x+w-r,y],[x+w-r+k,y],[x+w,y+r-k],[x+w,y+r]);
  cur.push([x+w,y+h-r]);
  bez([x+w,y+h-r],[x+w,y+h-r+k],[x+w-r+k,y+h],[x+w-r,y+h]);
  cur.push([x+r,y+h]);
  bez([x+r,y+h],[x+r-k,y+h],[x,y+h-r+k],[x,y+h-r]);
  cur.push([x,y+r]);
  bez([x,y+r],[x,y+r-k],[x+r-k,y],[x+r,y]);
  return [cur];
}
function circlePath(cx,cy,r){const sub=[];const N=Math.max(24,Math.ceil(r*12));
  for(let i=0;i<=N;i++){const a=i/N*Math.PI*2;sub.push([cx+r*Math.cos(a),cy+r*Math.sin(a)]);}return [sub];}
function ellipsePath(cx,cy,rx,ry){const sub=[];const N=Math.max(24,Math.ceil(Math.max(rx,ry)*12));
  for(let i=0;i<=N;i++){const a=i/N*Math.PI*2;sub.push([cx+rx*Math.cos(a),cy+ry*Math.sin(a)]);}return [sub];}
function strokePath(subs,width,cap){
  // round join/cap stroking by emitting the offset outline of each flattened polyline
  const half=width/2, out=[];
  const outR=[], backR=[];
  for(const sub of subs){
    if(sub.length<2) continue;
    const left=[],right=[];
    for(let i=0;i<sub.length;i++){
      const p=sub[i], a=sub[Math.max(0,i-1)], b=sub[Math.min(sub.length-1,i+1)];
      let dx=b[0]-a[0], dy=b[1]-a[1]; const L=Math.hypot(dx,dy)||1; dx/=L; dy/=L;
      left.push([p[0]-dy*half, p[1]+dx*half]); right.push([p[0]+dy*half, p[1]-dx*half]);
    }
    const outline=[...left, ...right.slice().reverse()];
    out.push(outline);
    if(cap==='round'){ out.push(circlePath(sub[0][0],sub[0][1],half)[0]); out.push(circlePath(sub[sub.length-1][0],sub[sub.length-1][1],half)[0]); }
    // join discs at interior vertices
    for(let i=1;i<sub.length-1;i++) out.push(circlePath(sub[i][0],sub[i][1],half)[0]);
  }
  return out;
}
function strokeMask(subs,width,W,H,SS){
  // Exact stroking as a distance field: fills every sample within width/2 of
  // the polyline. Round caps and round joins fall out of the same test, so no
  // self-overlapping outline (and no winding ambiguity) is involved.
  const w=W*SS,h=H*SS, half=width/2;
  const mask=new Uint8Array(w*h);
  for(const s of subs){
    if(s.length<2) continue;
    let ymin=1e9,ymax=-1,xmin=1e9,xmax=-1;
    for(const p of s){ if(p[1]<ymin)ymin=p[1]; if(p[1]>ymax)ymax=p[1]; if(p[0]<xmin)xmin=p[0]; if(p[0]>xmax)xmax=p[0]; }
    ymin=Math.max(0,Math.floor((ymin-half)*SS)); ymax=Math.min(h-1,Math.ceil((ymax+half)*SS));
    xmin=Math.max(0,Math.floor((xmin-half)*SS)); xmax=Math.min(w-1,Math.ceil((xmax+half)*SS));
    const r2=half*half;
    for(let y=ymin;y<=ymax;y++){
      const py=(y+0.5)/SS; const row=y*w;
      for(let x=xmin;x<=xmax;x++){
        if(mask[row+x]) continue;
        const px=(x+0.5)/SS;
        for(let i=0;i+1<s.length;i++){
          const a=s[i], b=s[i+1];
          let dx=b[0]-a[0], dy=b[1]-a[1];
          const L2=dx*dx+dy*dy;
          let t = L2>0 ? ((px-a[0])*dx+(py-a[1])*dy)/L2 : 0;
          t = t<0?0:(t>1?1:t);
          const qx=a[0]+t*dx-px, qy=a[1]+t*dy-py;
          if(qx*qx+qy*qy<=r2){ mask[row+x]=1; break; }
        }
      }
    }
  }
  return {mask,w,h};
}
function fillMask(subs,W,H,SS,combine){
  const w=W*SS,h=H*SS;
  const mask=new Uint8Array(w*h);
  let ymin=1e9,ymax=-1;
  for(const s of subs) for(const p of s){ if(p[1]<ymin)ymin=p[1]; if(p[1]>ymax)ymax=p[1]; }
  ymin=Math.max(0,Math.floor((ymin)*SS)); ymax=Math.min(h-1,Math.ceil(ymax*SS));
  // 'evenodd' : one crossing list for all subpaths, alternate pairs filled.
  // 'nonzero' : signed winding number, filled where it is non-zero. This is the
  //             correct definition for a stroked outline (offset ribbon).
  // 'union'   : each subpath filled even-odd on its own, then OR-ed together.
  const groups = combine==='union' ? subs : [subs.flat()];
  for(let y=ymin;y<=ymax;y++){
    const yc=(y+0.5)/SS;
    for(const s of groups){
      if(s.length<3) continue;
      const xs=[];
      for(let i=0;i<s.length;i++){
        const a=s[i], b=s[(i+1)%s.length];
        if((a[1]<=yc) !== (b[1]<=yc)){
          xs.push([a[0]+(yc-a[1])/(b[1]-a[1])*(b[0]-a[0]), a[1]<b[1]?1:-1]);
        }
      }
      if(xs.length<2) continue;
      xs.sort((p,q)=>p[0]-q[0]);
      if(combine==='nonzero'){
        let wind=0;
        for(let i=0;i<xs.length;i++){
          if(wind!==0){
            const x0=Math.max(0,Math.round(xs[i-1][0]*SS)), x1=Math.min(w-1,Math.round(xs[i][0]*SS));
            for(let x=x0;x<=x1;x++) mask[y*w+x]=1;
          }
          wind+=xs[i][1];
        }
      } else {
        for(let i=0;i+1<xs.length;i+=2){
          const x0=Math.max(0,Math.round(xs[i][0]*SS)), x1=Math.min(w-1,Math.round(xs[i+1][0]*SS));
          for(let x=x0;x<=x1;x++) mask[y*w+x]=1;
        }
      }
    }
  }
  return {mask,w,h};
}

function downscale(m,w,h,W,H,SS){
  const out=new Uint8Array(W*H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    let s=0;for(let dy=0;dy<SS;dy++)for(let dx=0;dx<SS;dx++)s+=m[(y*SS+dy)*w+(x*SS+dx)];
    out[y*W+x]=Math.round(255*s/(SS*SS));}
  return out;
}
function encodePNG(W,H,rgb){
  const raw=Buffer.alloc(H*(W*3+1));
  for(let y=0;y<H;y++){raw[y*(W*3+1)]=0;rgb.copy(raw,y*(W*3+1)+1,y*W*3,(y+1)*W*3);}
  const T=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
  const crc=b=>{let c=0xffffffff;for(const x of b)c=T[(c^x)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
  const ch=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type,'ascii'),data]);const cr=Buffer.alloc(4);cr.writeUInt32BE(crc(td));return Buffer.concat([len,td,cr]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),ch('IHDR',ihdr),ch('IDAT',zlib.deflateSync(raw,{level:9})),ch('IEND',Buffer.alloc(0))]);
}
export default {parsePath,rectPath,circlePath,ellipsePath,strokePath,fillMask,strokeMask,downscale,encodePNG}
