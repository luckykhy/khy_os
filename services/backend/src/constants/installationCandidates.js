'use strict';

/**
 * Known system-wide installation locations used only as discovery candidates.
 * Environment variables keep the values portable across Windows installations.
 */
const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

const WINDOWS_IDE_INSTALL_PATHS = Object.freeze({
  kiro: [
    pathJoin(programFiles, 'Kiro'),
    pathJoin(programFilesX86, 'Kiro'),
  ],
  cursor: [pathJoin(programFiles, 'Cursor')],
  trae: [
    pathJoin(programFiles, 'Trae CN'),
    pathJoin(programFiles, 'Trae'),
  ],
  warp: [pathJoin(programFiles, 'Warp')],
  windsurf: [pathJoin(programFiles, 'Windsurf')],
  vscode: [
    pathJoin(programFiles, 'Microsoft VS Code'),
    pathJoin(programFilesX86, 'Microsoft VS Code'),
  ],
});

const NIRVANA_STORAGE_CANDIDATES = Object.freeze([
  pathJoin(programFiles, 'nirvana', 'User', 'globalStorage', 'storage.json'),
  pathJoin(programFiles, 'Nirvana', 'User', 'globalStorage', 'storage.json'),
  pathJoin(programFiles, 'nirvana', 'storage.json'),
  pathJoin(programFiles, 'Nirvana', 'storage.json'),
]);

const NIRVANA_CACHE_CANDIDATES = Object.freeze([
  pathJoin(programFiles, 'nirvana', 'trae_local_cache.json'),
  pathJoin(programFiles, 'Nirvana', 'trae_local_cache.json'),
  pathJoin(programFilesX86, 'nirvana', 'trae_local_cache.json'),
]);

const GIT_BASH_CANDIDATES = Object.freeze([
  pathJoin(programFiles, 'Git', 'bin', 'git.exe'),
  pathJoin(programFilesX86, 'Git', 'bin', 'git.exe'),
  pathJoin(process.env.SystemDrive || 'C:', 'Git', 'bin', 'git.exe'),
]);

function pathJoin(...segments) {
  return segments.join('\\');
}

module.exports = {
  GIT_BASH_CANDIDATES,
  NIRVANA_CACHE_CANDIDATES,
  NIRVANA_STORAGE_CANDIDATES,
  WINDOWS_IDE_INSTALL_PATHS,
};
