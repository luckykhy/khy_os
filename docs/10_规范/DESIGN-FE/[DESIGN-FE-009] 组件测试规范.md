# [DESIGN-FE-009] 组件测试规范

> **定位**：单元测试 / 集成测试 / 视觉回归测试三层要求。
> **隶属**：本文是 [`[DESIGN-FE-002]` 前端组件库规范]([DESIGN-FE-002] 前端组件库规范.md) 的**子篇**；主篇是唯一入口与 scope 裁决真源，本文只承载细则。
> **状态**：随主篇——主篇 §0 声明为「目标态、非现状」，本文同样在组件库真正落地后才生效；在此之前一切以 [`[DESIGN-FE-001]` 前端页面规范]([DESIGN-FE-001] 前端页面规范.md) 为准。

---


### 4.1 单元测试

**测试文件结构**：
```
components/
├── KhyButton.vue
├── KhyButton.test.js
├── KhyInput.vue
└── KhyInput.test.js
```

**测试用例模板**：
```javascript
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import KhyButton from '../KhyButton.vue';

describe('KhyButton', () => {
  // 基础渲染
  describe('rendering', () => {
    it('renders correctly with default props', () => {
      const wrapper = mount(KhyButton, {
        slots: { default: 'Button' }
      });
      
      expect(wrapper.text()).toBe('Button');
      expect(wrapper.classes()).toContain('khy-button');
      expect(wrapper.classes()).toContain('khy-button--default');
    });
    
    it('renders with variant', () => {
      const wrapper = mount(KhyButton, {
        props: { variant: 'primary' },
        slots: { default: 'Button' }
      });
      
      expect(wrapper.classes()).toContain('khy-button--primary');
    });
    
    it('renders with size', () => {
      const wrapper = mount(KhyButton, {
        props: { size: 'lg' },
        slots: { default: 'Button' }
      });
      
      expect(wrapper.classes()).toContain('khy-button--lg');
    });
  });
  
  // Props 验证
  describe('props', () => {
    it('validates variant prop', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      mount(KhyButton, {
        props: { variant: 'invalid' }
      });
      
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
  
  // 事件处理
  describe('events', () => {
    it('emits click event', async () => {
      const wrapper = mount(KhyButton);
      
      await wrapper.trigger('click');
      
      expect(wrapper.emitted('click')).toBeTruthy();
      expect(wrapper.emitted('click')[0][0]).toBeInstanceOf(MouseEvent);
    });
    
    it('does not emit click when disabled', async () => {
      const wrapper = mount(KhyButton, {
        props: { disabled: true }
      });
      
      await wrapper.trigger('click');
      
      expect(wrapper.emitted('click')).toBeFalsy();
    });
    
    it('does not emit click when loading', async () => {
      const wrapper = mount(KhyButton, {
        props: { loading: true }
      });
      
      await wrapper.trigger('click');
      
      expect(wrapper.emitted('click')).toBeFalsy();
    });
  });
  
  // 插槽
  describe('slots', () => {
    it('renders default slot', () => {
      const wrapper = mount(KhyButton, {
        slots: { default: 'Custom Content' }
      });
      
      expect(wrapper.text()).toBe('Custom Content');
    });
    
    it('renders icon slot', () => {
      const wrapper = mount(KhyButton, {
        slots: {
          icon: '<span class="icon">🔍</span>'
        }
      });
      
      expect(wrapper.find('.icon').exists()).toBe(true);
    });
  });
  
  // 可访问性
  describe('accessibility', () => {
    it('has correct aria attributes when disabled', () => {
      const wrapper = mount(KhyButton, {
        props: { disabled: true }
      });
      
      expect(wrapper.attributes('disabled')).toBeDefined();
    });
    
    it('has correct aria attributes when loading', () => {
      const wrapper = mount(KhyButton, {
        props: { loading: true }
      });
      
      expect(wrapper.attributes('aria-busy')).toBe('true');
    });
  });
});
```

### 4.2 集成测试

**页面级测试**：
```javascript
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import UserProfile from '../UserProfile.vue';

describe('UserProfile', () => {
  const createWrapper = (options = {}) => {
    return mount(UserProfile, {
      global: {
        plugins: [
          createTestingPinia({
            initialState: {
              user: {
                name: 'John Doe',
                email: 'john@example.com',
                avatar: 'https://example.com/avatar.jpg'
              }
            }
          })
        ],
        stubs: {
          KhyButton: false,
          KhyCard: false
        }
      },
      ...options
    });
  };
  
  it('displays user information', () => {
    const wrapper = createWrapper();
    
    expect(wrapper.text()).toContain('John Doe');
    expect(wrapper.text()).toContain('john@example.com');
  });
  
  it('renders avatar', () => {
    const wrapper = createWrapper();
    
    const avatar = wrapper.find('.user-avatar');
    expect(avatar.exists()).toBe(true);
    expect(avatar.attributes('src')).toBe('https://example.com/avatar.jpg');
  });
  
  it('emits logout event', async () => {
    const wrapper = createWrapper();
    
    await wrapper.find('[data-testid="logout-button"]').trigger('click');
    
    expect(wrapper.emitted('logout')).toBeTruthy();
  });
});
```

### 4.3 视觉回归测试

**Storybook 配置**：
```javascript
// Button.stories.js
export default {
  title: 'Components/Base/KhyButton',
  component: KhyButton,
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: ['default', 'primary', 'success', 'warning', 'danger', 'ghost']
    },
    size: {
      control: { type: 'select' },
      options: ['sm', 'md', 'lg']
    },
    disabled: { control: 'boolean' },
    loading: { control: 'boolean' }
  }
};

const Template = (args) => ({
  components: { KhyButton },
  setup() {
    return { args };
  },
  template: '<KhyButton v-bind="args">{{ args.default }}</KhyButton>'
});

export const Default = Template.bind({});
Default.args = {
  default: 'Button',
  variant: 'default'
};

export const Primary = Template.bind({});
Primary.args = {
  default: 'Button',
  variant: 'primary'
};

export const Disabled = Template.bind({});
Disabled.args = {
  default: 'Button',
  variant: 'primary',
  disabled: true
};

export const Loading = Template.bind({});
Loading.args = {
  default: 'Button',
  variant: 'primary',
  loading: true
};
```

---
