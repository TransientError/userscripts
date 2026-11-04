# Repository layout

- Each userscript is an independent module, not a JavaScript package.
- Keep scripts with no companion files at the repository root.
- When a script has tests or documentation, place them together in a directory
  named after the script, without the `.user.js` suffix. Keep descriptive script
  and test filenames.
- Colocate specifications and Spec Kit artifacts with the owning script:
  `<module>/spec.md`, `<module>/plan.md`, `<module>/tasks.md`, and any supporting
  documents or checklists. Do not create a repository-level `specs/` tree.
- Adding a spec to a loose script promotes it to a module directory. Update any
  cross-module references when moving files.
- For Spec Kit, set `SPECIFY_FEATURE_DIRECTORY` to the owning module directory.
  Persist that relative path in `.specify/feature.json` as `feature_directory`
  when selecting a module for downstream commands. Do not infer the module from
  a numbered feature branch or reuse another module's selection.
- Update existing module documents rather than replacing them with blank
  templates. If module ownership is ambiguous, ask before writing.

# Tests

Run all tests from the repository root with `node --test`. Run a module's tests
with `node --test <module>/<module>.test.cjs`.
