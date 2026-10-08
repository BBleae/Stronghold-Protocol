// Configure before main's module graph creates the battle runner and its listeners.
import { configureRoomNet } from './room-net.js';
configureRoomNet();
await import('./main.js');
// 自选编队 (0.2.0): the picker offers the operators a DIY slot may field, which a Node server's page learns from the
// welcome at its start. A room Worker's page meets a room (and its welcome) only once it enters one: until then the
// list comes from the build (tools/build-worker.mjs, data-sp-diy-kitted: the Worker's own kit registry), so the menu's
// 干员调配 can pick; a room's welcome replaces it.
const kitted = document.documentElement.dataset.spDiyKitted;
if (kitted) {
  const { loadoutStore } = await import('./ui/loadoutSync.js');
  if (loadoutStore.get().diyKitted == null) loadoutStore.set({ diyKitted: kitted.split(',') });
}
