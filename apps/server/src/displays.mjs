import { createHash } from 'node:crypto';

export class DisplayInventory {
  constructor(rows) {
    this.update(rows);
  }
  update(rows) {
    if (!Array.isArray(rows) || rows.length > 64) throw new Error('Invalid display inventory');
    const ids = new Set();
    for (const row of rows) {
      if (
        !/^[a-f0-9]{64}$/.test(row.id) ||
        ids.has(row.id) ||
        typeof row.primary !== 'boolean' ||
        typeof row.persistent !== 'boolean' ||
        ![row.x, row.y, row.width, row.height].every(Number.isSafeInteger) ||
        row.width < 1 ||
        row.height < 1 ||
        ![0, 90, 180, 270].includes(row.rotation)
      )
        throw new Error('Invalid display inventory');
      ids.add(row.id);
    }
    this.rows = structuredClone(rows)
      .sort(
        (a, b) => Number(b.primary) - Number(a.primary) || a.x - b.x || a.id.localeCompare(b.id),
      )
      .map((row, index) => ({ ...row, number: index + 1 }));
    this.revision = createHash('sha256')
      .update(JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id))))
      .digest('hex');
  }
  allowed(policy) {
    return this.rows
      .filter((row) => row.persistent && policy.displaySharing?.[row.id] === true)
      .map((row) => ({ ...row }));
  }
  select(policy, id, revision) {
    if (revision !== undefined && revision !== this.revision)
      throw new Error('Display arrangement changed. Refresh the display list.');
    if (id !== undefined) {
      const display = this.rows.find((row) => row.id === id);
      if (!display) throw new Error('Selected display is unavailable');
      if (!display.persistent || policy.displaySharing?.[id] !== true)
        throw new Error('Selected display is not shared');
      return { ...display };
    }
    const allowed = this.allowed(policy);
    const display = allowed.find((row) => row.primary) ?? allowed[0];
    if (!display) throw new Error('No shared displays are available');
    return display;
  }
}
