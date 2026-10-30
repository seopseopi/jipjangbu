"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { Group } from "three";
import { muteRoomMaterials } from "./room-focus";

/** Keep shared textures/materials intact while a neighbouring room is selected. */
export function RoomContents({ dimmed, onSelect, children }: {
  dimmed: boolean; onSelect: () => void; children: ReactNode;
}) {
  const ref=useRef<Group>(null);
  useEffect(()=>{
    if(!dimmed || !ref.current)return;
    return muteRoomMaterials(ref.current);
  },[dimmed,children]);
  return <group ref={ref} onClick={e=>{e.stopPropagation();onSelect();}}>{children}</group>;
}
