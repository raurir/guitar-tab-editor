yarn build
aws s3 rm s3://raurir.com/apps/guitar-tab-editor/ --recursive --dryrun
aws s3 sync ./dist s3://raurir.com/apps/guitar-tab-editor/ --dryrun
aws cloudfront create-invalidation --distribution-id E34F50VVZYJIRI --paths '/apps/guitar-tab-editor/*'