# @pattern Command, Template Method
"""
重新训练ML模型 - 使用18个特征（与生产代码匹配）
"""

import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.naive_bayes import GaussianNB
from sklearn.neural_network import MLPClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score
import xgboost as xgb
import lightgbm as lgb
import joblib
import os
from datetime import datetime
import warnings
warnings.filterwarnings('ignore')

# 18个特征（与 mlAgentService.js 的 extractFeatures 方法完全一致）
FEATURE_NAMES = [
    'price', 'open', 'high', 'low', 'close',
    'ma5', 'ma10', 'ma20',
    'macd', 'rsi',
    'kdj_k', 'kdj_d', 'kdj_j',
    'volume', 'amount',
    'pe_ratio', 'pb_ratio', 'roe'
]

def generate_training_data(n_samples=10000):
    """
    生成训练数据（18个特征）
    """
    print(f"📊 生成 {n_samples} 条训练数据...")
    
    np.random.seed(42)
    
    data = {}
    
    # 生成18个特征
    for feature in FEATURE_NAMES:
        if feature in ['price', 'open', 'high', 'low', 'close']:
            # 价格特征 (10-100)
            data[feature] = np.random.uniform(10, 100, n_samples)
        elif feature in ['ma5', 'ma10', 'ma20']:
            # 均线 (10-100)
            data[feature] = np.random.uniform(10, 100, n_samples)
        elif feature == 'macd':
            # MACD (-5 到 5)
            data[feature] = np.random.uniform(-5, 5, n_samples)
        elif feature == 'rsi':
            # RSI (0-100)
            data[feature] = np.random.uniform(0, 100, n_samples)
        elif feature in ['kdj_k', 'kdj_d', 'kdj_j']:
            # KDJ (0-100)
            data[feature] = np.random.uniform(0, 100, n_samples)
        elif feature == 'volume':
            # 成交量
            data[feature] = np.random.uniform(1000000, 100000000, n_samples)
        elif feature == 'amount':
            # 成交额
            data[feature] = np.random.uniform(10000000, 1000000000, n_samples)
        elif feature == 'pe_ratio':
            # 市盈率
            data[feature] = np.random.uniform(5, 50, n_samples)
        elif feature == 'pb_ratio':
            # 市净率
            data[feature] = np.random.uniform(0.5, 10, n_samples)
        elif feature == 'roe':
            # ROE
            data[feature] = np.random.uniform(0, 30, n_samples)
    
    df = pd.DataFrame(data)
    
    # 生成标签（基于简单规则）
    # 规则：如果 ma5 > ma10 且 rsi > 50，则标签为1（看涨），否则为0（看跌）
    df['label'] = ((df['ma5'] > df['ma10']) & (df['rsi'] > 50)).astype(int)
    
    print(f"✅ 数据生成完成")
    print(f"   特征数: {len(FEATURE_NAMES)}")
    print(f"   样本数: {len(df)}")
    print(f"   标签分布: {df['label'].value_counts().to_dict()}")
    
    return df

def train_models(X_train, y_train, X_test, y_test):
    """
    训练6个智能体模型
    """
    print("\n🚀 开始训练6个智能体...")
    print("=" * 60)
    
    models_config = {
        'market_analyst': {
            'model': RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42, n_jobs=-1),
            'name': '市场分析师 (Random Forest)'
        },
        'technical_analyst': {
            'model': xgb.XGBClassifier(n_estimators=100, max_depth=6, learning_rate=0.1, random_state=42, use_label_encoder=False, eval_metric='logloss'),
            'name': '技术分析师 (XGBoost)'
        },
        'fundamental_analyst': {
            'model': lgb.LGBMClassifier(n_estimators=100, max_depth=8, learning_rate=0.1, random_state=42, verbose=-1),
            'name': '基本面分析师 (LightGBM)'
        },
        'news_analyst': {
            'model': GaussianNB(),
            'name': '新闻分析师 (Naive Bayes)'
        },
        'risk_analyst': {
            'model': LogisticRegression(C=1.0, max_iter=1000, random_state=42, n_jobs=-1),
            'name': '风险分析师 (Logistic Regression)'
        },
        'strategy_analyst': {
            'model': MLPClassifier(hidden_layer_sizes=(64, 32, 16), max_iter=500, random_state=42),
            'name': '策略分析师 (MLP)'
        }
    }
    
    trained_models = {}
    
    for i, (agent_name, config) in enumerate(models_config.items(), 1):
        print(f"\n[{i}/6] 训练 {config['name']}...")
        print("-" * 60)
        
        try:
            model = config['model']
            
            # 训练
            model.fit(X_train, y_train)
            
            # 评估
            y_pred = model.predict(X_test)
            accuracy = accuracy_score(y_test, y_pred)
            precision = precision_score(y_test, y_pred, average='weighted', zero_division=0)
            recall = recall_score(y_test, y_pred, average='weighted', zero_division=0)
            f1 = f1_score(y_test, y_pred, average='weighted', zero_division=0)
            
            print(f"✅ 训练完成")
            print(f"   准确率: {accuracy:.4f}")
            print(f"   精确率: {precision:.4f}")
            print(f"   召回率: {recall:.4f}")
            print(f"   F1分数: {f1:.4f}")
            
            trained_models[agent_name] = {
                'model': model,
                'metrics': {
                    'accuracy': accuracy,
                    'precision': precision,
                    'recall': recall,
                    'f1_score': f1
                }
            }
            
        except Exception as e:
            print(f"❌ 训练失败: {str(e)}")
            continue
    
    return trained_models

def save_models(models, save_dir='./models'):
    """
    保存模型
    """
    os.makedirs(save_dir, exist_ok=True)
    
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    
    print(f"\n💾 保存模型到: {save_dir}")
    print("=" * 60)
    
    for agent_name, data in models.items():
        model = data['model']
        
        # 保存带时间戳的版本
        model_path = os.path.join(save_dir, f'{agent_name}_{timestamp}.joblib')
        joblib.dump(model, model_path)
        
        # 保存最新版本
        latest_path = os.path.join(save_dir, f'{agent_name}_latest.joblib')
        joblib.dump(model, latest_path)
        
        print(f"✅ {agent_name}")
        print(f"   {latest_path}")
    
    # 保存训练信息
    training_info = {
        'timestamp': timestamp,
        'feature_count': len(FEATURE_NAMES),
        'features': FEATURE_NAMES,
        'models': {name: data['metrics'] for name, data in models.items()}
    }
    
    info_path = os.path.join(save_dir, f'training_info_{timestamp}.joblib')
    joblib.dump(training_info, info_path)
    
    print(f"\n✅ 所有模型已保存！")
    print(f"\n📋 训练信息:")
    print(f"   时间戳: {timestamp}")
    print(f"   特征数: {len(FEATURE_NAMES)}")
    print(f"   模型数: {len(models)}")

def main():
    print("🤖 ML模型训练系统 (18特征版本)")
    print("=" * 60)
    
    # 1. 生成训练数据
    df = generate_training_data(n_samples=10000)
    
    # 2. 准备特征和标签
    X = df[FEATURE_NAMES]
    y = df['label']
    
    # 3. 划分训练集和测试集
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )
    
    print(f"\n📊 数据划分:")
    print(f"   训练集: {X_train.shape}")
    print(f"   测试集: {X_test.shape}")
    
    # 4. 训练模型
    models = train_models(X_train, y_train, X_test, y_test)
    
    # 5. 保存模型
    save_models(models)
    
    print("\n" + "=" * 60)
    print("🎉 训练完成！")
    print("\n📝 下一步:")
    print("   1. 检查 backend/ml/models/ 目录")
    print("   2. 上传模型到服务器:")
    # 部署主机走 env,未配置时回落到占位符(不写死真实生产拓扑)。
    deploy_host = os.environ.get("KHY_DEPLOY_HOST", "<your-server>")
    print(f"      scp backend/ml/models/*_latest.joblib root@{deploy_host}:/var/www/KHY-Quant/backend/ml/models/")
    print("   3. 重启服务器后端:")
    print(f"      ssh root@{deploy_host} 'cd /var/www/KHY-Quant/backend && pm2 restart khy-backend'")

if __name__ == '__main__':
    main()
