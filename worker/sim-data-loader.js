import { getData } from '../server/data.js';

export async function loadGenerated() { return getData(); }
export async function reloadGenerated() { return getData(); }
export function loadResearch() { return {}; }
