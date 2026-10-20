import { cleanupImages } from '../src/evidence.js';
import { withDatabase, db } from '../src/db.js';
try { await withDatabase(true,cleanupImages); } finally {await db.close();}
