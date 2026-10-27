// Tests read game data from the local House Flipper install, like the app does.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseCollections } = require('../main/handlers.js');

export const GAME_DIR = process.env.HF_GAME || 'D:/SteamLibrary/steamapps/common/House Flipper';
const ASSET = path.join(GAME_DIR, 'Assets', 'Resources', 'Exporter', 'HFCollections.asset');

export const hasGame = fs.existsSync(ASSET);

export function loadCollections() {
  return parseCollections(fs.readFileSync(ASSET, 'utf8'));
}
