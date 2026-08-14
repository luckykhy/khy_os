'use strict';

const {
  detectTeaching,
  TEACH_PRINCIPLE_RE,
  isDirectiveTowardAi,
  isPrincipleGuarded,
} = require('../intentGate');

describe('detectTeaching – principle false-positive guard', () => {
  // ── Should NOT be identified as teaching ─────────────────────────────────
  describe('should NOT identify as teaching (false-positive guard)', () => {
    test('platform rule description: 小k太多了，又不允许多个字母一起注册，怎么办', () => {
      const r = detectTeaching('小k太多了，又不允许多个字母一起注册，怎么办');
      expect(r.isTeaching).toBe(false);
    });

    test('platform rule with prefix: 公众号小k太多了，又不允许多个字母一起注册，怎么办', () => {
      const r = detectTeaching('公众号小k太多了，又不允许多个字母一起注册，怎么办');
      expect(r.isTeaching).toBe(false);
    });

    test('platform rule without 怎么办: 公众号小k太多了，又不允许多个字母一起注册', () => {
      const r = detectTeaching('公众号小k太多了，又不允许多个字母一起注册');
      expect(r.isTeaching).toBe(false);
    });

    test('external restriction: 平台不允许注册', () => {
      const r = detectTeaching('平台不允许注册');
      expect(r.isTeaching).toBe(false);
    });

    test('external restriction: 规定不准', () => {
      const r = detectTeaching('规定不准');
      expect(r.isTeaching).toBe(false);
    });

    test('question sentence ending with 如何: 平台不允许注册如何', () => {
      const r = detectTeaching('平台不允许注册如何');
      expect(r.isTeaching).toBe(false);
    });
  });

  // ── Should STILL be identified as teaching ───────────────────────────────
  describe('should STILL identify as teaching (true positives)', () => {
    test('AI-directed: 你不允许撒谎', () => {
      const r = detectTeaching('你不允许撒谎');
      expect(r.isTeaching).toBe(true);
      expect(r.target).toBe('principles');
    });

    test('AI-directed: 您禁止访问外网', () => {
      const r = detectTeaching('您禁止访问外网');
      expect(r.isTeaching).toBe(true);
      expect(r.target).toBe('principles');
    });

    test('imperative sentence start: 禁止泄露密码', () => {
      const r = detectTeaching('禁止泄露密码');
      expect(r.isTeaching).toBe(true);
      expect(r.target).toBe('principles');
    });

    test('strong signal: 永远不要忘记', () => {
      const r = detectTeaching('永远不要忘记');
      expect(r.isTeaching).toBe(true);
      expect(r.target).toBe('principles');
    });

    test('strong signal: 你必须不泄露密码', () => {
      const r = detectTeaching('你必须不泄露密码');
      expect(r.isTeaching).toBe(true);
      expect(r.target).toBe('principles');
    });

    test('strong signal: 绝不允许', () => {
      const r = detectTeaching('绝不允许');
      expect(r.isTeaching).toBe(true);
      expect(r.target).toBe('principles');
    });

    test('strong signal (English): never lie to me', () => {
      const r = detectTeaching('never lie to me');
      expect(r.isTeaching).toBe(true);
      expect(r.target).toBe('principles');
    });

    test('strong signal: 不可以偷懒', () => {
      const r = detectTeaching('不可以偷懒');
      expect(r.isTeaching).toBe(true);
      expect(r.target).toBe('principles');
    });
  });
});

describe('TEACH_PRINCIPLE_RE – regex unit checks', () => {
  test('matches 你 + directive keyword (now via isDirectiveTowardAi)', () => {
    expect(isDirectiveTowardAi('你不允许撒谎')).toBe(true);
    expect(isDirectiveTowardAi('你禁止迟到')).toBe(true);
    expect(isDirectiveTowardAi('你不准跑')).toBe(true);
  });

  test('matches sentence-initial directive (now via isDirectiveTowardAi)', () => {
    expect(isDirectiveTowardAi('禁止泄露密码')).toBe(true);
    expect(isDirectiveTowardAi('不准迟到')).toBe(true);
    expect(isDirectiveTowardAi('不允许偷懒')).toBe(true);
  });

  test('matches strong signals anywhere', () => {
    expect(TEACH_PRINCIPLE_RE.test('绝不')).toBe(true);
    expect(TEACH_PRINCIPLE_RE.test('永远不要忘记')).toBe(true);
    expect(TEACH_PRINCIPLE_RE.test('从不')).toBe(true);
    expect(TEACH_PRINCIPLE_RE.test('不可以')).toBe(true);
    expect(TEACH_PRINCIPLE_RE.test('必须不')).toBe(true);
  });

  test('does NOT match directive words (now handled by isDirectiveTowardAi)', () => {
    expect(TEACH_PRINCIPLE_RE.test('禁止泄露密码')).toBe(false);
    expect(TEACH_PRINCIPLE_RE.test('不准迟到')).toBe(false);
    expect(TEACH_PRINCIPLE_RE.test('不允许偷懒')).toBe(false);
  });
});

describe('isDirectiveTowardAi – directive-word helper', () => {
  test('matches AI pronoun within 10 chars', () => {
    expect(isDirectiveTowardAi('你不允许撒谎')).toBe(true);
    expect(isDirectiveTowardAi('写代码时你不允许用全局变量')).toBe(true);
  });

  test('matches sentence-initial directive (imperative mood)', () => {
    expect(isDirectiveTowardAi('禁止泄露密码')).toBe(true);
    expect(isDirectiveTowardAi('不准迟到')).toBe(true);
    expect(isDirectiveTowardAi('不允许偷懒')).toBe(true);
  });

  test('matches context marker (时/以后) within 6 chars', () => {
    expect(isDirectiveTowardAi('写代码时不允许用全局变量')).toBe(true);
    expect(isDirectiveTowardAi('以后不准迟到')).toBe(true);
  });

  test('does NOT match with external-constraint prefix', () => {
    expect(isDirectiveTowardAi('平台不允许注册')).toBe(false);
    expect(isDirectiveTowardAi('又不允许多个字母一起注册')).toBe(false);
    expect(isDirectiveTowardAi('规定不准')).toBe(false);
    expect(isDirectiveTowardAi('公众号禁止注册')).toBe(false);
  });
});

describe('detectTeaching – round-2 regression fixes', () => {
  test('mid-sentence AI pronoun + directive: 写代码时你不允许用全局变量', () => {
    const r = detectTeaching('写代码时你不允许用全局变量');
    expect(r.isTeaching).toBe(true);
    expect(r.target).toBe('principles');
  });

  test('subject-less context marker + directive: 写代码时不允许用全局变量', () => {
    const r = detectTeaching('写代码时不允许用全局变量');
    expect(r.isTeaching).toBe(true);
    expect(r.target).toBe('principles');
  });

  test('preference + strong constraint → principles: 以后不允许撒谎', () => {
    const r = detectTeaching('以后不允许撒谎');
    expect(r.isTeaching).toBe(true);
    expect(r.target).toBe('principles');
  });

  test('strong signal + sentence-final question word: 绝不要问我为什么', () => {
    const r = detectTeaching('绝不要问我为什么');
    expect(r.isTeaching).toBe(true);
    expect(r.target).toBe('principles');
  });

  test('platform question NOT teaching: 平台不允许注册怎么办', () => {
    const r = detectTeaching('平台不允许注册怎么办');
    expect(r.isTeaching).toBe(false);
  });

  test('platform question NOT teaching: 公众号禁止注册怎么办', () => {
    const r = detectTeaching('公众号禁止注册怎么办');
    expect(r.isTeaching).toBe(false);
  });
});

describe('detectTeaching – round-3 guard: quoted speech / attribution', () => {
  test('你说 + directive: 你说不允许', () => {
    const r = detectTeaching('你说不允许');
    expect(r.isTeaching).toBe(false);
  });

  test('他说 + directive: 他说禁止这样做', () => {
    const r = detectTeaching('他说禁止这样做');
    expect(r.isTeaching).toBe(false);
  });

  test('有人说 + principle keyword: 有人说绝不可以', () => {
    const r = detectTeaching('有人说绝不可以');
    expect(r.isTeaching).toBe(false);
  });

  test('你觉得 + directive: 你觉得不应该这样做', () => {
    const r = detectTeaching('你觉得不应该这样做');
    expect(r.isTeaching).toBe(false);
  });
});

describe('detectTeaching – round-3 guard: conditional / hypothetical', () => {
  test('如果 + directive: 如果不允许怎么办', () => {
    const r = detectTeaching('如果不允许怎么办');
    expect(r.isTeaching).toBe(false);
  });

  test('假设 + directive: 假设禁止使用这个方案', () => {
    const r = detectTeaching('假设禁止使用这个方案');
    expect(r.isTeaching).toBe(false);
  });

  test('即使 + principle keyword: 即使绝不可以也要做', () => {
    const r = detectTeaching('即使绝不可以也要做');
    expect(r.isTeaching).toBe(false);
  });

  test('假如 + principle: 假如必须不这样做', () => {
    const r = detectTeaching('假如必须不这样做');
    expect(r.isTeaching).toBe(false);
  });
});

describe('detectTeaching – round-3 guard: self-directed', () => {
  test('我自己 + directive: 我自己不允许这样做', () => {
    const r = detectTeaching('我自己不允许这样做');
    expect(r.isTeaching).toBe(false);
  });

  test('我本人 + principle: 我本人绝不可以', () => {
    const r = detectTeaching('我本人绝不可以');
    expect(r.isTeaching).toBe(false);
  });
});

describe('detectTeaching – round-3 guard: negative request (double negation)', () => {
  test('不要禁止: 不要禁止我说话', () => {
    const r = detectTeaching('不要禁止我说话');
    expect(r.isTeaching).toBe(false);
  });

  test('别 + directive: 别不准我注册', () => {
    const r = detectTeaching('别不准我注册');
    expect(r.isTeaching).toBe(false);
  });
});

describe('detectTeaching – round-3 guard: extended external subjects', () => {
  test('公司禁止加班', () => {
    const r = detectTeaching('公司禁止加班');
    expect(r.isTeaching).toBe(false);
  });

  test('微信不允许', () => {
    const r = detectTeaching('微信不允许');
    expect(r.isTeaching).toBe(false);
  });

  test('法律禁止', () => {
    const r = detectTeaching('法律禁止');
    expect(r.isTeaching).toBe(false);
  });

  test('学校不准迟到', () => {
    const r = detectTeaching('学校不准迟到');
    expect(r.isTeaching).toBe(false);
  });

  test('政策不允许', () => {
    const r = detectTeaching('政策不允许');
    expect(r.isTeaching).toBe(false);
  });
});

describe('detectTeaching – round-3 guard: interrogative coverage', () => {
  test('你不允许吗？', () => {
    const r = detectTeaching('你不允许吗？');
    expect(r.isTeaching).toBe(false);
  });

  test('禁止吗？', () => {
    const r = detectTeaching('禁止吗？');
    expect(r.isTeaching).toBe(false);
  });

  test('是不是不可以？', () => {
    const r = detectTeaching('是不是不可以？');
    expect(r.isTeaching).toBe(false);
  });
});

describe('detectTeaching – round-3 true positives still hold', () => {
  test('AI-directed + context: 写代码时禁止用全局变量', () => {
    const r = detectTeaching('写代码时禁止用全局变量');
    expect(r.isTeaching).toBe(true);
    expect(r.target).toBe('principles');
  });

  test('strong signal standalone: 绝不', () => {
    const r = detectTeaching('绝不');
    expect(r.isTeaching).toBe(true);
    expect(r.target).toBe('principles');
  });

  test('imperative + principle: 禁止在代码中硬编码密码', () => {
    const r = detectTeaching('禁止在代码中硬编码密码');
    expect(r.isTeaching).toBe(true);
    expect(r.target).toBe('principles');
  });

  test('从不在正式场合使用: 从不在正式场合使用口语', () => {
    const r = detectTeaching('从不在正式场合使用口语');
    expect(r.isTeaching).toBe(true);
    expect(r.target).toBe('principles');
  });
});

describe('isPrincipleGuarded – unit checks', () => {
  test('quoted context is guarded', () => {
    expect(isPrincipleGuarded('他说绝不可以')).toBe(true);
    expect(isPrincipleGuarded('你说不可以')).toBe(true);
  });

  test('conditional context is guarded', () => {
    expect(isPrincipleGuarded('如果绝不可以')).toBe(true);
    expect(isPrincipleGuarded('假如必须不')).toBe(true);
  });

  test('self-directed context is guarded', () => {
    expect(isPrincipleGuarded('我自己绝不可以')).toBe(true);
  });

  test('genuine directive is NOT guarded', () => {
    expect(isPrincipleGuarded('绝不可以')).toBe(false);
    expect(isPrincipleGuarded('必须不撒谎')).toBe(false);
    expect(isPrincipleGuarded('从不说谎')).toBe(false);
  });

  test('text without principle keywords returns true (vacuously guarded)', () => {
    expect(isPrincipleGuarded('普通句子')).toBe(true);
  });
});

describe('detectTeaching – round-4: 你/您 + 又/也/还 adverb (false-negative fix)', () => {
  // ── AI subject before 又/也/还 → genuine principle (true positives) ────────
  test('你也不可以撒谎', () => {
    const r = detectTeaching('你也不可以撒谎');
    expect(r.isTeaching).toBe(true);
    expect(r.target).toBe('principles');
  });

  test('你又不允许撒谎', () => {
    const r = detectTeaching('你又不允许撒谎');
    expect(r.isTeaching).toBe(true);
    expect(r.target).toBe('principles');
  });

  test('你还不允许泄露密码', () => {
    const r = detectTeaching('你还不允许泄露密码');
    expect(r.isTeaching).toBe(true);
    expect(r.target).toBe('principles');
  });

  // ── No AI subject before adverb → still external (false-positive guard) ────
  test('又不允许多个字母一起注册 (no AI subject)', () => {
    const r = detectTeaching('又不允许多个字母一起注册');
    expect(r.isTeaching).toBe(false);
  });
});

describe('detectTeaching – round-4: conditional AI-directed rule (false-negative fix)', () => {
  // ── Conditional + AI-directed rule → principle (true positive) ────────────
  test('如果用户骂人，你不可以回应', () => {
    const r = detectTeaching('如果用户骂人，你不可以回应');
    expect(r.isTeaching).toBe(true);
    expect(r.target).toBe('principles');
  });

  // ── Conditional questions / external subjects → still excluded ────────────
  test('平台不允许注册怎么办', () => {
    const r = detectTeaching('平台不允许注册怎么办');
    expect(r.isTeaching).toBe(false);
  });

  test('如果不允许怎么办', () => {
    const r = detectTeaching('如果不允许怎么办');
    expect(r.isTeaching).toBe(false);
  });

  test('公司禁止加班', () => {
    const r = detectTeaching('公司禁止加班');
    expect(r.isTeaching).toBe(false);
  });

  test('你说不允许 (quoted context)', () => {
    const r = detectTeaching('你说不允许');
    expect(r.isTeaching).toBe(false);
  });
});

describe('detectTeaching – round-4: original misfires still false', () => {
  test('小k太多了，又不允许多个字母一起注册，怎么办', () => {
    const r = detectTeaching('小k太多了，又不允许多个字母一起注册，怎么办');
    expect(r.isTeaching).toBe(false);
  });

  test('公众号小k太多了，又不允许多个字母一起注册，怎么办', () => {
    const r = detectTeaching('公众号小k太多了，又不允许多个字母一起注册，怎么办');
    expect(r.isTeaching).toBe(false);
  });

  test('公众号小k太多了，又不允许多个字母一起注册', () => {
    const r = detectTeaching('公众号小k太多了，又不允许多个字母一起注册');
    expect(r.isTeaching).toBe(false);
  });
});
