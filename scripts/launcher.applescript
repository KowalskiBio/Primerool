-- Source of the Primerool.app launcher bundle (the built .app is untracked; *.app/ is gitignored).
-- It runs ./Run_primerool.command from the folder the app sits in, logging to /tmp/primerool_launch.log.
-- Rebuild with: osacompile -o Primerool.app scripts/launcher.applescript
set myPath to POSIX path of (path to me)
set scriptDir to do shell script "dirname " & quoted form of myPath
do shell script "cd " & quoted form of scriptDir & " && export PATH=\"/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/Users/kowalski/.miniconda3/bin:$PATH\" && ./Run_primerool.command > /tmp/primerool_launch.log 2>&1 &"

