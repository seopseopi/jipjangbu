import { Color, Mesh, type Object3D } from "three";

/** Clone, mute, then restore materials. Adjacent rooms often share originals. */
export function muteRoomMaterials(root: Object3D) {
  const cleanups: (()=>void)[]=[];
  root.traverse(object=>{
    if(!(object instanceof Mesh))return;
    const original=object.material;
    const originals=Array.isArray(original)?original:[original];
    const clones=originals.map(material=>{
      const muted=material.clone();
      muted.opacity=material.opacity*.22;
      muted.transparent=true;
      muted.depthWrite=false;
      if('color' in muted && muted.color instanceof Color)muted.color.lerp(new Color('#d3d8d4'),.3);
      return muted;
    });
    object.material=Array.isArray(original)?clones:clones[0];
    cleanups.push(()=>{object.material=original;clones.forEach(material=>material.dispose());});
  });
  return ()=>cleanups.forEach(cleanup=>cleanup());
}
