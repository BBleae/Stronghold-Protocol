import { getData } from '../server/data.js';
import { restoreMatch,RecordedMatch } from '../server/match/checkpoint.js';
export function restore(checkpoint,deps) {return restoreMatch(checkpoint,{...deps,data:getData()});}
export function create(options) {return new RecordedMatch({...options,data:getData()});}
