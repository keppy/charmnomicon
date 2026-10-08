-- Shelf zero: an admin-set mark on the games everyone plays together.
-- NULL = not shelved; the only value in use is 'zero'. Shelved charms lead the home page.
ALTER TABLE apps ADD COLUMN shelf TEXT;
