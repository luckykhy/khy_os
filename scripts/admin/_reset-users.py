import sqlite3, sys

db = r"D:\portable\khy-os\services\backend\data\khy-quant.db"
con = sqlite3.connect(db)
cur = con.cursor()

# Check what's in users table
cur.execute("SELECT id, username, email, role, status FROM users")
rows = cur.fetchall()
print("Users in DB:")
for r in rows:
    print(f"  id={r[0]} username={r[1]} email={r[2]} role={r[3]} status={r[4]}")

# Delete existing users
cur.execute("DELETE FROM users")
con.commit()
print("\nDeleted all users.")

# Verify
cur.execute("SELECT COUNT(*) FROM users")
print(f"Users remaining: {cur.fetchone()[0]}")

con.close()
