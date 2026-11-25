-- Adds a link back to the Projects page at the bottom of every project page.
-- Loaded for all pages in projects/ through projects/_metadata.yml,
-- so a new project page gets the link without any extra line.
-- The look is set in css/theme.scss (.back-to-projects).

function Pandoc(doc)
  local link = pandoc.Link("Back to all projects", "../projects.html")
  doc.blocks:insert(pandoc.Div({ pandoc.Para({ link }) }, pandoc.Attr("", { "back-to-projects" })))
  return doc
end
