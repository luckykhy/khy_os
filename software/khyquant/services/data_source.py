# @pattern Command, Template Method
"""
Data Source Abstraction Layer — Strategy Pattern with Factory Switch

Design:
    DataSource (ABC)            <- contract: get_stock_data() -> DataFrame
      ├─ AkshareDataSource      <- real market data via ak.stock_zh_a_hist()
      └─ InternalMockDataSource <- placeholder for internal company data

    get_data_source(use_internet) <- factory that returns the right source

All implementations MUST return a DataFrame with these columns:
    ['date', 'open', 'high', 'low', 'close', 'volume']

Usage:
    source = get_data_source(use_internet=True)
    df = source.get_stock_data("000001", "20240101", "20241231")
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)

# Canonical columns every DataSource must return.
REQUIRED_COLUMNS = ["date", "open", "high", "low", "close", "volume"]


# =====================================================================
# Abstract Base Class
# =====================================================================
class DataSource(ABC):
    """Contract for all K-line data sources.

    Every concrete subclass MUST return a DataFrame whose columns are
    exactly ``REQUIRED_COLUMNS``.  Rows are sorted by date ascending.
    """

    @abstractmethod
    def get_stock_data(
        self,
        symbol: str,
        start_date: str,
        end_date: str,
    ) -> pd.DataFrame:
        """Fetch K-line data for *symbol* between *start_date* and *end_date*.

        Args:
            symbol:     6-digit A-share code, e.g. ``"000001"`` or ``"600519"``.
            start_date: Inclusive start, format ``YYYYMMDD``.
            end_date:   Inclusive end,   format ``YYYYMMDD``.

        Returns:
            DataFrame with columns ``['date','open','high','low','close','volume']``.
            Returns an **empty** DataFrame (with those columns) on failure.
        """


# =====================================================================
# Real Implementation — AKShare
# =====================================================================
class AkshareDataSource(DataSource):
    """Fetches real A-share K-line data from AKShare.

    Uses ``ak.stock_zh_a_hist()`` which returns Chinese column names::

        日期, 开盘, 收盘, 最高, 最低, 成交量, 成交额, 振幅, 涨跌幅, 涨跌额, 换手率

    These are renamed to the standard English columns before return.
    """

    # AKShare returns Chinese headers; map them to our standard names.
    _COLUMN_MAP = {
        "日期": "date",
        "开盘": "open",
        "最高": "high",
        "最低": "low",
        "收盘": "close",
        "成交量": "volume",
    }

    def get_stock_data(
        self,
        symbol: str,
        start_date: str,
        end_date: str,
    ) -> pd.DataFrame:
        empty = pd.DataFrame(columns=REQUIRED_COLUMNS)

        try:
            import akshare as ak
        except ImportError:
            logger.error("akshare is not installed — cannot fetch real data")
            return empty

        try:
            df = ak.stock_zh_a_hist(
                symbol=symbol,
                period="daily",
                start_date=start_date,
                end_date=end_date,
                adjust="qfq",
            )

            if df is None or df.empty:
                logger.warning("AKShare returned no data for %s", symbol)
                return empty

            # Rename Chinese columns -> English.
            df.rename(columns=self._COLUMN_MAP, inplace=True)

            # Normalise date to string "YYYY-MM-DD".
            df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")

            # Keep only the canonical columns.
            df = df[REQUIRED_COLUMNS].copy()

            # Ensure numeric types.
            for col in ["open", "high", "low", "close", "volume"]:
                df[col] = pd.to_numeric(df[col], errors="coerce")

            df.sort_values("date", inplace=True)
            df.reset_index(drop=True, inplace=True)

            logger.info(
                "AKShare: fetched %d rows for %s (%s ~ %s)",
                len(df), symbol, start_date, end_date,
            )
            return df

        except Exception as exc:
            logger.error("AKShare fetch failed for %s: %s", symbol, exc)
            return empty


# =====================================================================
# Placeholder — Internal Company Mock Data
# =====================================================================
class InternalMockDataSource(DataSource):
    """Placeholder for the company-internal mock K-line generator.

    The actual data format is TBD.  When you figure out whether it is
    a CSV file, a local HTTP API, or a database table, replace the
    ``raise NotImplementedError`` in ``get_stock_data`` with one of the
    implementation templates below.

    ---------------------------------------------------------------
    TEMPLATE A — Local CSV / Parquet file
    ---------------------------------------------------------------
    ::

        import os

        DATA_DIR = "/path/to/internal/kline_files"

        def get_stock_data(self, symbol, start_date, end_date):
            file_path = os.path.join(DATA_DIR, f"{symbol}.csv")
            df = pd.read_csv(file_path, parse_dates=["date"])

            # If columns are named differently, rename them:
            # df.rename(columns={"trade_date": "date", ...}, inplace=True)

            df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
            df = df[(df["date"] >= start_date) & (df["date"] <= end_date)]
            return df[REQUIRED_COLUMNS].reset_index(drop=True)

    ---------------------------------------------------------------
    TEMPLATE B — Local HTTP API (e.g. Flask / FastAPI on localhost)
    ---------------------------------------------------------------
    ::

        import requests

        API_BASE = "http://192.168.x.x:8080/api/kline"

        def get_stock_data(self, symbol, start_date, end_date):
            resp = requests.get(
                f"{API_BASE}/{symbol}",
                params={"start": start_date, "end": end_date},
                timeout=10,
            )
            resp.raise_for_status()
            records = resp.json()["data"]  # adjust key as needed
            df = pd.DataFrame(records)

            # Rename to standard columns if needed:
            # df.rename(columns={"ts": "date", "o": "open", ...}, inplace=True)

            return df[REQUIRED_COLUMNS].reset_index(drop=True)

    ---------------------------------------------------------------
    TEMPLATE C — Database (MySQL / PostgreSQL via SQLAlchemy)
    ---------------------------------------------------------------
    ::

        from sqlalchemy import create_engine

        ENGINE = create_engine("mysql+pymysql://user:pass@host/db")

        def get_stock_data(self, symbol, start_date, end_date):
            query = '''
                SELECT trade_date AS date, open, high, low, close, volume
                FROM kline_daily
                WHERE symbol = :sym
                  AND trade_date BETWEEN :sd AND :ed
                ORDER BY trade_date
            '''
            df = pd.read_sql(
                query, ENGINE,
                params={"sym": symbol, "sd": start_date, "ed": end_date},
            )
            df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
            return df[REQUIRED_COLUMNS].reset_index(drop=True)

    """

    def get_stock_data(
        self,
        symbol: str,
        start_date: str,
        end_date: str,
    ) -> pd.DataFrame:
        # ── Replace this block with Template A / B / C above ──
        raise NotImplementedError(
            "TODO: Connect to internal company data source. "
            "See the class docstring for CSV / API / DB templates."
        )


# =====================================================================
# Factory Function
# =====================================================================
def get_data_source(use_internet: bool = False) -> DataSource:
    """Return the appropriate DataSource based on network availability.

    Args:
        use_internet: True  -> AkshareDataSource  (real market data)
                      False -> InternalMockDataSource (company internal)
    """
    if use_internet:
        logger.info("DataSource switch: ONLINE  -> AkshareDataSource")
        return AkshareDataSource()

    logger.info("DataSource switch: OFFLINE -> InternalMockDataSource")
    return InternalMockDataSource()


# =====================================================================
# Test Script
# =====================================================================
if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    SYMBOL = "600519"          # Kweichow Moutai
    START = "20240101"
    END = "20241231"

    # --- Test 1: AKShare (real data, requires internet) ---------------
    print("=" * 60)
    print("TEST 1 — AkshareDataSource (use_internet=True)")
    print("=" * 60)
    try:
        source = get_data_source(use_internet=True)
        df = source.get_stock_data(SYMBOL, START, END)
        if df.empty:
            print(f"  No data returned (network may be unavailable).")
        else:
            print(f"  Rows:    {len(df)}")
            print(f"  Columns: {list(df.columns)}")
            print(f"  Head:\n{df.head().to_string(index=False)}")
            print(f"  Tail:\n{df.tail().to_string(index=False)}")
    except Exception as e:
        print(f"  Error: {e}")

    # --- Test 2: Internal Mock (offline, hits NotImplementedError) -----
    print()
    print("=" * 60)
    print("TEST 2 — InternalMockDataSource (use_internet=False)")
    print("=" * 60)
    try:
        source = get_data_source(use_internet=False)
        df = source.get_stock_data(SYMBOL, START, END)
        print(f"  Rows: {len(df)}")
    except NotImplementedError as e:
        print(f"  Expected error caught: {e}")
        print("  (This is correct — fill in the internal logic later.)")
    except Exception as e:
        print(f"  Unexpected error: {e}")

    print()
    print("Done. Both code paths exercised successfully.")
