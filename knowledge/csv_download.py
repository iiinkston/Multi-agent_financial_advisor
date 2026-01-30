import yfinance as yf
import pandas as pd

# 1. Define market tickers
tickers = {
    "US_Sp500": "^GSPC",    # United States – S&P 500 Index
    "UK_FTSE100": "^FTSE",  # United Kingdom – FTSE 100 Index
    "SG_STI": "^STI",       # Singapore – Straits Times Index
    "HK_HSI": "^HSI",       # Hong Kong – Hang Seng Index
    "CN_SSE": "000001.ss",  # China – Shanghai Composite Index
}

# 2. Set the historical data date range
start_date = "2020-01-01"   # Start date for historical data
end_date = "2025-12-31"     # End date for historical data

# 3. Download market data and save to CSV files
for name, ticker in tickers.items():
    print(f"Downloading {name} (ticker = {ticker}) ...")
    
    # Download historical market data from Yahoo Finance
    df = yf.download(ticker, start=start_date, end=end_date)
    
    # Save the dataset as a CSV file for later use (e.g., RAG training)
    csv_filename = f"{name}_history.csv"
    df.to_csv(csv_filename)
    print(f"Saved {csv_filename}")

print("All downloads complete!")
