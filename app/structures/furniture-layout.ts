import type { Point, Room } from "./plan";

function inside([x, y]: Point, polygon: Point[]) {
  let hit = false;
  polygon.forEach((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    if ((a[1] > y) !== (b[1] > y) && x < a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) hit = !hit;
  });
  return hit;
}
/** Check the entire footprint, including a concave notch between its corners. */
export function furnitureFits(room: Room, x: number, y: number, width: number, depth: number) {
  const l = x - width / 2, r = x + width / 2, t = y - depth / 2, b = y + depth / 2;
  const corners: Point[] = [[l,t],[r,t],[r,b],[l,b]];
  if (!corners.every(p => inside(p, room.polygon))) return false;
  const cross = (a: Point, b: Point, c: Point) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  return room.polygon.every((a, i) => {
    const z = room.polygon[(i+1)%room.polygon.length];
    if (a[0]>l && a[0]<r && a[1]>t && a[1]<b) return false;
    return corners.every((c,j) => {
      const d = corners[(j+1)%4];
      return !(cross(a,z,c)*cross(a,z,d)<0 && cross(c,d,a)*cross(c,d,z)<0);
    });
  });
}
export function bedPlacement(room: Room, master: boolean) {
  const xs=room.polygon.map(p=>p[0]), ys=room.polygon.map(p=>p[1]);
  const l=Math.min(...xs), r=Math.max(...xs), t=Math.min(...ys), b=Math.max(...ys);
  const width=Math.min(master?1.6:1.05,r-l-0.6), depth=Math.min(2.05,b-t-0.55);
  if (width<0.7 || depth<1.3) return null;
  // Include bed frame/headboard and a small margin, then prefer the old location.
  const fits=(x:number,y:number)=>furnitureFits(room,x,y,width+0.24,depth+0.24);
  const preferred: Point=[master?(l+r)/2:r-width/2-0.22,b-depth/2-0.18];
  if (fits(...preferred)) return {x:preferred[0],y:preferred[1],width,depth};
  const candidates: Point[]=[];
  for(let y=t+depth/2+0.15;y<b-depth/2-0.12;y+=0.12)
    for(let x=l+width/2+0.15;x<r-width/2-0.12;x+=0.12)
      if(fits(x,y)) candidates.push([x,y]);
  candidates.sort((a,z)=>Math.hypot(a[0]-preferred[0],a[1]-preferred[1])-Math.hypot(z[0]-preferred[0],z[1]-preferred[1]));
  return candidates.length?{x:candidates[0][0],y:candidates[0][1],width,depth}:null;
}
