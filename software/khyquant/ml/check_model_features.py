# @pattern Template Method
"""
检查现有模型的特征数量
"""

import joblib
import os
import numpy as np

def check_model_features(model_path):
    """检查模型期望的特征数量"""
    try:
        model = joblib.load(model_path)
        
        # 尝试用不同数量的特征进行预测，看看模型期望多少特征
        for n_features in [18, 49]:
            try:
                X_test = np.random.rand(1, n_features)
                model.predict(X_test)
                return n_features
            except Exception as e:
                if "features" in str(e):
                    continue
        
        return "未知"
    except Exception as e:
        return f"错误: {str(e)}"

def main():
    models_dir = './models'
    
    print("🔍 检查模型特征数量")
    print("=" * 60)
    
    if not os.path.exists(models_dir):
        print(f"❌ 模型目录不存在: {models_dir}")
        return
    
    # 检查所有 *_latest.joblib 文件
    agents = [
        'market_analyst',
        'technical_analyst',
        'fundamental_analyst',
        'news_analyst',
        'risk_analyst',
        'strategy_analyst'
    ]
    
    for agent in agents:
        model_path = os.path.join(models_dir, f'{agent}_latest.joblib')
        
        if os.path.exists(model_path):
            n_features = check_model_features(model_path)
            print(f"✅ {agent:25s} -> {n_features} 个特征")
        else:
            print(f"❌ {agent:25s} -> 文件不存在")
    
    print("\n" + "=" * 60)
    print("📋 说明:")
    print("   - 如果显示 49 个特征，需要重新训练")
    print("   - 如果显示 18 个特征，可以直接上传到服务器")

if __name__ == '__main__':
    main()
