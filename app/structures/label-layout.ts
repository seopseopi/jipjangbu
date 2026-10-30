export type RoomLabelAnchor = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
};
export type RoomLabelPlacement = RoomLabelAnchor & { visible: boolean; moved: boolean };

/** Place important labels first. A crowded view may omit secondary labels, but
 * never draws overlapping names or detaches a name without a leader line. */
export function layoutRoomLabels(
  anchors: RoomLabelAnchor[],
  width: number,
  height: number,
): RoomLabelPlacement[] {
  const gap = 5, margin = 8;
  const placed: RoomLabelPlacement[] = [];
  for (const anchor of [...anchors].sort((a,b) => b.priority-a.priority || a.id.localeCompare(b.id))) {
    const w=anchor.width, h=anchor.height;
    let choice: {x:number;y:number} | undefined;
    if (w>0 && h>0 && w+margin*2<=width && h+margin*2<=height &&
      [anchor.x,anchor.y,w,h,width,height].every(Number.isFinite)) {
      const candidates=[{x:anchor.x,y:anchor.y}];
      for(const radius of [1,2,3])
        for(const [dx,dy] of [[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[1,-1],[-1,1],[1,1]])
          candidates.push({x:anchor.x+dx*Math.min(w*.65+gap,40)*radius,
            y:anchor.y+dy*(h+gap)*radius});
      const unique = new Set<string>();
      for(const p of candidates) {
        const x=Math.max(margin+w/2,Math.min(width-margin-w/2,p.x));
        const y=Math.max(margin+h/2,Math.min(height-margin-h/2,p.y));
        const key=`${x}:${y}`;
        if(unique.has(key)||Math.hypot(x-anchor.x,y-anchor.y)>125)continue;
        unique.add(key);
        if(placed.every(q=>!q.visible || Math.abs(x-q.x)>=(w+q.width)/2+gap || Math.abs(y-q.y)>=(h+q.height)/2+gap)){
          choice={x,y};break;
        }
      }
    }
    placed.push({...anchor,...choice,visible:!!choice,moved:!!choice&&Math.hypot(choice.x-anchor.x,choice.y-anchor.y)>8});
  }
  return placed;
}
