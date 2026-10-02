// Configure before main's module graph creates the battle runner and its listeners.
import { configureRoomNet } from './room-net.js';
configureRoomNet();
await import('./main.js');
