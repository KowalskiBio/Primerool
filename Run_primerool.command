#!/bin/bash

# Get the directory where this script is located
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "Starting Primeroonline..."

# Check if Python 3 is installed, auto-install if missing
if ! command -v python3 &> /dev/null; then
    echo "Python 3 not found. Attempting to install automatically..."

    OS="$(uname -s)"

    if [ "$OS" = "Darwin" ]; then
        # macOS: try Homebrew first, then fall back to official installer
        if command -v brew &> /dev/null; then
            echo "Installing Python via Homebrew..."
            brew install python3
        else
            echo "Homebrew not found. Downloading Python installer for macOS..."
            curl -L -o /tmp/python_installer.pkg "https://www.python.org/ftp/python/3.12.9/python-3.12.9-macos11.pkg"
            if [ $? -ne 0 ]; then
                echo "Download failed. Please install Python manually from https://www.python.org/downloads/mac-osx/"
                read -p "Press Enter to exit..."
                exit 1
            fi
            echo "Running installer (you may be prompted for your password)..."
            sudo installer -pkg /tmp/python_installer.pkg -target /
        fi

    elif [ "$OS" = "Linux" ]; then
        # Linux: detect package manager
        if command -v apt-get &> /dev/null; then
            echo "Installing Python via apt..."
            sudo apt-get update -qq && sudo apt-get install -y python3 python3-venv python3-pip
        elif command -v dnf &> /dev/null; then
            echo "Installing Python via dnf..."
            sudo dnf install -y python3
        elif command -v pacman &> /dev/null; then
            echo "Installing Python via pacman..."
            sudo pacman -Sy --noconfirm python
        else
            echo "Could not detect a package manager. Please install Python 3 manually."
            read -p "Press Enter to exit..."
            exit 1
        fi
    else
        echo "Unsupported OS: $OS. Please install Python 3 manually."
        read -p "Press Enter to exit..."
        exit 1
    fi

    # Re-check after install
    if ! command -v python3 &> /dev/null; then
        echo "Python installation failed or requires opening a new terminal."
        echo "Please close and reopen this script, or install Python manually from https://www.python.org/downloads/"
        read -p "Press Enter to exit..."
        exit 1
    fi

    echo "Python installed successfully."
fi

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate

# Install dependencies if needed
if [ -f "requirements.txt" ]; then
    echo "Checking dependencies..."
    pip install -r requirements.txt
fi

# Open browser after a short delay
(sleep 3 && open "http://127.0.0.1:5050") &

# Run the application
echo "Server running at http://127.0.0.1:5050"
echo "Press Ctrl+C to stop the server."
python src/app.py
