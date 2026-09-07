// One validator for build, archive, install, update, Console, and public proof.
// The implementation ships with the plugin so installed activation boundaries execute the exact
// same byte/inventory checks as release assembly.
export { validatePublicInventory } from '../plugin/scripts/coverage-integrity.mjs';
