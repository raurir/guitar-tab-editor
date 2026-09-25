yarn build
aws s3 rm s3://raurir.com/apps/guitar-tab-editor/ --recursive
aws s3 sync ./dist s3://raurir.com/apps/guitar-tab-editor/
aws s3 sync ./tabs s3://raurir.com/apps/guitar-tab-editor/tabs/
aws cloudfront create-invalidation --distribution-id E34F50VVZYJIRI --paths '/apps/guitar-tab-editor/*'