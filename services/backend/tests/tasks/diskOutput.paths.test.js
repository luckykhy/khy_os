'use strict';

const path = require('path');

jest.mock('../../src/utils/storageRoots', () => ({
  resolveGeneratedFileDir: jest.fn(() => ({
    dir: require('path').resolve('regular-install-tasks'),
  })),
}));

jest.mock('../../src/utils/dataHome', () => ({
  getDataHome: jest.fn(() => require('path').resolve('portable-data')),
  isPortableDeployment: jest.fn(() => false),
}));

const dataHome = require('../../src/utils/dataHome');
const storageRoots = require('../../src/utils/storageRoots');
const diskOutput = require('../../src/tasks/diskOutput');

describe('diskOutput portable directory contract', () => {
  const oldEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.KHY_TASK_OUTPUT_DIR;
    delete process.env.KHY_TEMP_HOME;
    dataHome.isPortableDeployment.mockReturnValue(false);
    dataHome.getDataHome.mockReturnValue(path.resolve('portable-data'));
    storageRoots.resolveGeneratedFileDir.mockClear();
    diskOutput._resetOutputDir();
  });

  afterAll(() => {
    process.env = { ...oldEnv };
    diskOutput._resetOutputDir();
  });

  test('explicit task output directory has highest precedence', () => {
    process.env.KHY_TASK_OUTPUT_DIR = path.join('explicit root', 'tasks');
    process.env.KHY_TEMP_HOME = path.resolve('ignored-temp');
    dataHome.isPortableDeployment.mockReturnValue(true);

    expect(diskOutput.getTaskOutputDir()).toBe(path.resolve(process.env.KHY_TASK_OUTPUT_DIR));
  });

  test('launcher temp home keeps task output inside portable state', () => {
    process.env.KHY_TEMP_HOME = path.resolve('portable temp');

    expect(diskOutput.getTaskOutputDir()).toBe(
      path.join(path.resolve(process.env.KHY_TEMP_HOME), 'tasks')
    );
    expect(storageRoots.resolveGeneratedFileDir).not.toHaveBeenCalled();
  });

  test('portable deployment falls back to canonical data home', () => {
    dataHome.isPortableDeployment.mockReturnValue(true);
    const portableData = path.resolve('portable root', '.khy');
    dataHome.getDataHome.mockReturnValue(portableData);

    expect(diskOutput.getTaskOutputDir()).toBe(path.join(portableData, 'tmp', 'tasks'));
    expect(storageRoots.resolveGeneratedFileDir).not.toHaveBeenCalled();
  });

  test('regular install retains storage capacity policy', () => {
    const regularDir = path.resolve('regular-install-tasks');

    expect(diskOutput.getTaskOutputDir()).toBe(regularDir);
    expect(storageRoots.resolveGeneratedFileDir).toHaveBeenCalledWith({
      subdir: path.join('tmp', 'tasks'),
      preferCwd: false,
    });
  });
});
