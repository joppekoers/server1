#!/bin/bash
export PASSPHRASE='INJECT_PASSPHRASE'
export GOOGLE_SERVICE_JSON_FILE=/home/joppe/server1/duplicity/rclone-435014-cc5a3af12bc1.json

echo 'INJECT_GOOGLE_SERVICE_JSON' > $GOOGLE_SERVICE_JSON_FILE
DRIVE_ID='INJECT_DRIVE_ID'

# duplicity backup --verbosity info --progress --allow-source-mismatch --exclude-filelist /home/joppe/server1/duplicity/ignore_googledrive /home/joppe/files "gdrive://duplicity@rclone-435014.iam.gserviceaccount.com/server1_backup/?driveID=$DRIVE_ID"


if ssh offsite "mountpoint -q /home/joppe/offsite-files"; then
	duplicity backup --verbosity info --progress --allow-source-mismatch --exclude-filelist /home/joppe/server1/duplicity/ignore_offsite /home/joppe/files 'rsync://offsite://home/joppe/offsite-files/duplicity'
else
	echo Remote disk not mounted
	exit 1
fi


# duplicity restore --verbosity info --progress --allow-source-mismatch \
#   'rsync://offsite//home/joppe/offsite-files/duplicity' \
#   /home/joppe/server1/duplicity2