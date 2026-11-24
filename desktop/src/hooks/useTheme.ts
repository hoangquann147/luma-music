import { useState } from 'react';
export type Theme='dark'|'light';
function savedTheme():Theme {
  try{return localStorage.getItem('luma.theme')==='light'?'light':'dark'}catch{return 'dark'}
}
// Set before the React tree mounts so opening the app never flashes the light UI.
document.documentElement.dataset.theme=savedTheme();
export function useTheme(){
  const [theme,setTheme]=useState<Theme>(savedTheme);
  const toggleTheme=()=>setTheme(current=>{
    const next=current==='dark'?'light':'dark';document.documentElement.dataset.theme=next;
    try{localStorage.setItem('luma.theme',next)}catch{/* A restricted storage host can still switch for this session. */}
    return next;
  });
  return {theme,toggleTheme};
}
