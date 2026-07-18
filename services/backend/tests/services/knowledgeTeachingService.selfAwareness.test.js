'use strict';

describe('knowledgeTeachingService self-awareness profile', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('builds a structured self-awareness profile', () => {
    jest.doMock('../../src/services/growthService', () => ({
      loadComponent: jest.fn((name) => {
        if (name === 'knowledge.json') {
          return {
            level: 'beginner',
            xp: 12,
            completedTopics: ['ma_basics'],
            topicProgress: {},
            interactionsSinceLastTip: 0,
          };
        }
        return {};
      }),
      saveComponent: jest.fn(),
    }));

    const kts = require('../../src/services/knowledgeTeachingService');
    const profile = kts.getSelfAwarenessProfile({
      studyMode: true,
      adapter: 'codex',
      model: 'gpt-4o',
      effort: 'high',
    });

    expect(profile.studyMode).toBe(true);
    expect(profile.runtime.adapter).toBe('codex');
    expect(profile.runtime.model).toBe('gpt-4o');
    expect(profile.learner.levelName).toBeDefined();
    expect(profile.knowledgeBase.totalCount).toBeGreaterThan(0);
    expect(Array.isArray(profile.capabilities)).toBe(true);
    expect(profile.capabilities.length).toBeGreaterThan(0);
    expect(Array.isArray(profile.boundaries)).toBe(true);
    expect(profile.boundaries.length).toBeGreaterThan(0);
    expect(Array.isArray(profile.teachingProtocol)).toBe(true);
    expect(profile.teachingProtocol.length).toBeGreaterThan(0);
  });

  test('renders study mode prompt contract marker', () => {
    jest.doMock('../../src/services/growthService', () => ({
      loadComponent: jest.fn(() => ({
        level: 'beginner',
        xp: 0,
        completedTopics: [],
        topicProgress: {},
        interactionsSinceLastTip: 0,
      })),
      saveComponent: jest.fn(),
    }));

    const kts = require('../../src/services/knowledgeTeachingService');
    const promptBlock = kts.buildStudyModePromptContext({
      studyMode: true,
      adapter: 'codex',
      model: 'gpt-4o',
      effort: 'medium',
    });

    expect(promptBlock).toContain('KHY_STUDY_MODE_LEARNING_CONTRACT');
    expect(promptBlock).toContain('已知/假设/未知');
    expect(promptBlock).toContain('教学协议');
  });
});
